"""Who may edit the room.

With no passcode and no sign-in proxy configured, anyone who can reach the
server can edit, as before. Once a passcode is set (from Customize in the
app), screens and visitors can look but every change needs a browser that has
been unlocked with it. A reverse proxy that signs people in can also name the
editors, through a header the server is told to trust.

The passcode is stored only as a salted PBKDF2 hash. An unlocked browser holds
a signed, expiring cookie; changing or removing the passcode ends every session.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import threading
import time
from collections import deque
from http.cookies import SimpleCookie
from typing import Any, Mapping, Optional

from .config import Config
from .db import Database

COOKIE = "obeya_edit"
MIN_LENGTH = 6
MAX_LENGTH = 200
ITERATIONS = 200_000
MAX_FAILURES = 8          # wrong passcodes allowed ...
FAILURE_WINDOW = 300      # ... in this many seconds, across all browsers
CACHE_SECONDS = 10        # how long another process's change (the reset command) can go unnoticed


class AccessError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def _hash(passcode: str, salt: bytes, iterations: int) -> str:
    return hashlib.pbkdf2_hmac("sha256", passcode.encode("utf-8"), salt, iterations).hex()


class AccessControl:
    def __init__(self, db: Database, cfg: Config):
        self.db = db
        self.header = cfg.auth_header
        self.editors = {e.strip().casefold() for e in cfg.editors if e.strip()}
        self.session_seconds = max(300, int(cfg.edit_session_hours * 3600))
        self._lock = threading.Lock()
        self._failures: deque[float] = deque()
        self._cached: Optional[tuple[float, dict, bytes]] = None

    # ---- stored state ----

    def _load(self) -> tuple[dict, bytes]:
        """The passcode record and the signing key, cached briefly."""
        with self._lock:
            if self._cached and time.time() - self._cached[0] < CACHE_SECONDS:
                return self._cached[1], self._cached[2]
        record = self.db.kv_get("edit_lock") or {"version": 0, "hash": None}
        secret = self.db.kv_get("edit_secret")
        if not isinstance(secret, dict) or not secret.get("key"):
            secret = {"key": secrets.token_hex(32)}
            self.db.kv_set("edit_secret", secret)
        key = bytes.fromhex(secret["key"])
        with self._lock:
            self._cached = (time.time(), record, key)
        return record, key

    def _store(self, record: dict) -> None:
        self.db.kv_set("edit_lock", record)
        with self._lock:
            self._cached = None

    # ---- sessions ----

    def _sign(self, key: bytes, expires: int, version: int) -> str:
        return hmac.new(key, f"{expires}.{version}".encode("ascii"), hashlib.sha256).hexdigest()

    def _cookie(self, headers: Mapping[str, str], value: str, max_age: int) -> str:
        secure = "; Secure" if str(headers.get("X-Forwarded-Proto") or "").lower() == "https" else ""
        return f"{COOKIE}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{secure}"

    def _session_cookie(self, headers: Mapping[str, str]) -> str:
        record, key = self._load()
        expires = int(time.time()) + self.session_seconds
        version = int(record.get("version") or 0)
        return self._cookie(headers, f"{expires}.{version}.{self._sign(key, expires, version)}", self.session_seconds)

    def clear_cookie(self, headers: Mapping[str, str]) -> str:
        return self._cookie(headers, "", 0)

    def _has_session(self, headers: Mapping[str, str], record: dict, key: bytes) -> bool:
        try:
            morsel = SimpleCookie(headers.get("Cookie") or "").get(COOKIE)
        except Exception:
            return False
        if morsel is None:
            return False
        parts = morsel.value.split(".")
        if len(parts) != 3:
            return False
        try:
            expires, version = int(parts[0]), int(parts[1])
        except ValueError:
            return False
        if expires <= time.time() or version != int(record.get("version") or 0):
            return False
        return hmac.compare_digest(parts[2], self._sign(key, expires, version))

    # ---- what the API asks ----

    def describe(self, headers: Mapping[str, str]) -> dict:
        """The Access object for this request."""
        record, key = self._load()
        passcode_set = bool(record.get("hash"))
        user = (str(headers.get(self.header) or "").strip() or None) if self.header else None
        locked = passcode_set or bool(self.header)
        by_proxy = bool(user) and ("*" in self.editors or user.casefold() in self.editors)
        can_edit = (not locked) or by_proxy or (passcode_set and self._has_session(headers, record, key))
        return {"locked": locked, "canEdit": can_edit, "passcodeSet": passcode_set, "user": user}

    def _check(self, passcode: Any, record: dict) -> bool:
        """Constant-time passcode check, with a shared limit on wrong guesses."""
        now = time.time()
        with self._lock:
            while self._failures and now - self._failures[0] > FAILURE_WINDOW:
                self._failures.popleft()
            if len(self._failures) >= MAX_FAILURES:
                raise AccessError(429, "Too many wrong passcodes. Wait a few minutes and try again.")
        ok = False
        if isinstance(passcode, str) and record.get("hash") and len(passcode) <= MAX_LENGTH:
            candidate = _hash(passcode, bytes.fromhex(record["salt"]), int(record.get("iterations") or ITERATIONS))
            ok = hmac.compare_digest(candidate, record["hash"])
        if not ok:
            with self._lock:
                self._failures.append(now)
        return ok

    def unlock(self, passcode: Any, headers: Mapping[str, str]) -> str:
        """Returns the Set-Cookie value for an unlocked session."""
        record, _ = self._load()
        if not record.get("hash"):
            raise AccessError(400, "No passcode is set, so there is nothing to unlock.")
        if not self._check(passcode, record):
            raise AccessError(403, "That passcode is not right.")
        return self._session_cookie(headers)

    def set_passcode(self, current: Any, new: Any, headers: Mapping[str, str]) -> str:
        """Set, change or remove (new == "") the passcode. Returns a Set-Cookie value
        that keeps the caller unlocked, or clears the cookie when it is removed."""
        record, _ = self._load()
        if record.get("hash") and not self._check(current, record):
            raise AccessError(403, "The current passcode is not right.")
        if not isinstance(new, str):
            raise AccessError(400, "The new passcode must be text.")
        version = int(record.get("version") or 0) + 1   # ends every existing session
        if new == "":
            self._store({"version": version, "hash": None})
            return self.clear_cookie(headers)
        if len(new) < MIN_LENGTH:
            raise AccessError(400, f"Use at least {MIN_LENGTH} characters for the passcode.")
        if len(new) > MAX_LENGTH:
            raise AccessError(400, "That passcode is too long.")
        salt = secrets.token_bytes(16)
        self._store({"version": version, "salt": salt.hex(), "iterations": ITERATIONS,
                     "hash": _hash(new, salt, ITERATIONS)})
        return self._session_cookie(headers)

    def reset(self) -> bool:
        """Remove the passcode without knowing it (the server-side reset command).
        Returns whether there was one."""
        record = self.db.kv_get("edit_lock") or {"version": 0, "hash": None}
        had = bool(record.get("hash"))
        self._store({"version": int(record.get("version") or 0) + 1, "hash": None})
        return had
