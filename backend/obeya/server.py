"""HTTP API and static file server, on the standard library.

Reading the room is open to anyone who can reach the port, so TVs need no
sign-in. Editing is open too until a passcode is set in the app (or a sign-in
proxy is trusted); from then on everything except reading the room needs an
unlocked browser. See access.py.
"""
from __future__ import annotations

import hashlib
import json
import logging
import mimetypes
from dataclasses import dataclass, field
from email.message import Message
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Mapping, Optional
from urllib.parse import urlsplit

from .access import AccessControl, AccessError
from .config import Config
from .db import Database
from .diagnostics import run_diagnostics
from .jira_client import JiraError, JiraUnavailable
from .flow import clean_blocked_rule
from .periods import clean_calendar, field_ref
from .sources import normalize_auto, normalize_board, normalize_metric, normalize_source, text_values
from .sync import Syncer

log = logging.getLogger("obeya.http")
MAX_BODY = 2 * 1024 * 1024


@dataclass
class Request:
    body: Any
    headers: Mapping[str, str]
    set_cookies: list = field(default_factory=list)   # Set-Cookie values for the response


class ApiError(Exception):
    def __init__(self, status: int, message: str, extra: Optional[dict] = None):
        super().__init__(message)
        self.status = status
        self.extra = extra or {}


# ---------- validation ----------

def validate_room(room: Any) -> dict:
    if not isinstance(room, dict) or not isinstance(room.get("walls"), list):
        raise ApiError(400, "That is not a room: it has no list of walls.")
    for wall in room["walls"]:
        if not isinstance(wall, dict) or not isinstance(wall.get("id"), str) or not wall["id"] \
                or not isinstance(wall.get("panels"), list):
            raise ApiError(400, "Every wall needs an id and a list of panels.")
        for panel in wall["panels"]:
            if not isinstance(panel, dict) or not isinstance(panel.get("id"), str) \
                    or not isinstance(panel.get("type"), str) or not isinstance(panel.get("data"), dict):
                raise ApiError(400, "Every panel needs an id, a type and data.")
    return room


def clean_settings(raw: Any) -> dict:
    if not isinstance(raw, dict):
        raise ApiError(400, "Settings must be an object.")
    jira = raw.get("jira") if isinstance(raw.get("jira"), dict) else {}
    board = jira.get("boardId")
    if isinstance(board, bool) or not isinstance(board, int) or board <= 0:
        board = None
    return {
        "jira": {
            "piField": str(jira.get("piField") or "").strip()[:100],
            "storyPointsField": str(jira.get("storyPointsField") or "").strip()[:100],
            "boardId": board,
            "showSummaries": jira.get("showSummaries", True) is not False,
            "showAssignees": jira.get("showAssignees", True) is not False,
            "blocked": clean_blocked_rule(jira.get("blocked")),
        },
        "pis": clean_calendar(raw.get("pis")),
    }


# ---------- application ----------

class App:
    def __init__(self, cfg: Config, db: Database, syncer: Syncer):
        self.cfg = cfg
        self.db = db
        self.syncer = syncer
        self.access = AccessControl(db, cfg)
        # Handlers take the request body. The few that need headers or set a cookie take
        # the whole Request and are listed in self.wants_request.
        self.routes: dict[tuple[str, str], Callable[[Any], Any]] = {
            ("GET", "/api/health"): self.health,
            ("GET", "/api/state"): self.state,
            ("POST", "/api/unlock"): self.unlock,
            ("POST", "/api/lock"): self.lock,
            ("PUT", "/api/passcode"): self.set_passcode,
            ("PUT", "/api/room"): self.save_room,
            ("GET", "/api/settings"): self.get_settings,
            ("PUT", "/api/settings"): self.save_settings,
            ("POST", "/api/sync"): self.sync_now,
            ("GET", "/api/jira/status"): self.jira_status,
            ("GET", "/api/jira/diagnostics"): self.jira_diagnostics,
            ("GET", "/api/jira/fields"): self.jira_fields,
            ("GET", "/api/jira/boards"): self.jira_boards,
            ("GET", "/api/jira/pi-values"): self.jira_pi_values,
            ("POST", "/api/jira/preview"): self.jira_preview,
        }
        self.wants_request = {self.state, self.unlock, self.lock, self.set_passcode}
        # Open to everyone, locked or not. Everything else needs edit rights once locked:
        # that includes the Jira endpoints, which would otherwise let a visitor run
        # queries with the service account.
        self.open_routes = {("GET", "/api/health"), ("GET", "/api/state"),
                            ("POST", "/api/unlock"), ("POST", "/api/lock")}

    def health(self, _body: Any) -> dict:
        self.db.get_room()
        return {"ok": True}

    def unlock(self, req: Request) -> dict:
        passcode = req.body.get("passcode") if isinstance(req.body, dict) else None
        try:
            req.set_cookies.append(self.access.unlock(passcode, req.headers))
        except AccessError as err:
            raise ApiError(err.status, str(err))
        return {**self.access.describe(req.headers), "canEdit": True}

    def lock(self, req: Request) -> dict:
        req.set_cookies.append(self.access.clear_cookie(req.headers))
        without_cookie = Message()   # what this browser will look like once the cookie is gone
        for name, value in req.headers.items():
            if name.lower() != "cookie":
                without_cookie[name] = value
        return self.access.describe(without_cookie)

    def set_passcode(self, req: Request) -> dict:
        body = req.body if isinstance(req.body, dict) else {}
        try:
            req.set_cookies.append(self.access.set_passcode(body.get("current"), body.get("next"), req.headers))
        except AccessError as err:
            raise ApiError(err.status, str(err))
        described = self.access.describe(req.headers)
        # The caller keeps editing: the new cookie is on its way with this response.
        return {**described, "canEdit": True}

    def jira_diagnostics(self, _body: Any) -> dict:
        return run_diagnostics(self.syncer.client(), self.db.get_settings(), self.cfg.jira_configured)

    def state(self, req: Request) -> dict:
        row = self.db.get_room()
        settings = self.db.get_settings()
        room = row["doc"] if row else None
        return {
            "room": room,
            "version": row["version"] if row else 0,
            "updatedAt": row["updated_at"].isoformat(timespec="seconds") if row else None,
            **self.syncer.results_for(room),
            "periods": self.syncer.periods(settings),
            "sync": self.syncer.status(),
            "access": self.access.describe(req.headers),
        }

    def save_room(self, body: Any) -> dict:
        if not isinstance(body, dict):
            raise ApiError(400, "Expected {room, baseVersion}.")
        room = validate_room(body.get("room"))
        base = body.get("baseVersion")
        if isinstance(base, bool) or not isinstance(base, int) or base < 0:
            raise ApiError(400, "baseVersion must be a whole number.")
        saved = self.db.save_room(room, base)
        if saved is None:
            current = self.db.get_room()
            raise ApiError(409, "conflict", {"version": current["version"] if current else 0,
                                             "room": current["doc"] if current else None})
        self.syncer.wake()
        return {"version": saved["version"], "updatedAt": saved["updated_at"].isoformat(timespec="seconds")}

    def get_settings(self, _body: Any) -> dict:
        return clean_settings(self.db.get_settings())

    def save_settings(self, body: Any) -> dict:
        settings = clean_settings(body)
        self.db.save_settings(settings)
        self.syncer.wake(full=True, force=True)
        return settings

    def sync_now(self, _body: Any) -> dict:
        if not self.cfg.jira_configured:
            return {"ok": False, "error": "Jira is not connected. Set JIRA_BASE_URL and JIRA_TOKEN on the server.",
                    "sources": 0, "durationMs": 0}
        return self.syncer.run(full=True, force=True)

    def jira_status(self, _body: Any) -> dict:
        out = {"configured": self.cfg.jira_configured, "ok": False, "baseUrl": self.cfg.jira_base_url or None,
               "deployment": None, "version": None, "error": None}
        client = self.syncer.client()
        if client is None:
            out["error"] = "Jira is not connected. Set JIRA_BASE_URL and JIRA_TOKEN on the server."
            return out
        try:
            info = client.server_info()
            # serverInfo answers anonymously on some instances, so prove the token with a real call.
            client.search("order by created desc", ["summary"], limit=1)
            out.update(ok=True, deployment=str(info.get("deploymentType") or "Server"),
                       version=str(info.get("version") or "") or None)
        except JiraError as err:
            out["error"] = str(err)
        return out

    def _client(self):
        client = self.syncer.client()
        if client is None:
            raise ApiError(503, "Jira is not connected. Set JIRA_BASE_URL and JIRA_TOKEN on the server.")
        return client

    def jira_fields(self, _body: Any) -> list:
        fields = self._client().fields()
        out = [{"id": str(f.get("id")), "name": str(f.get("name") or f.get("id")), "custom": bool(f.get("custom"))}
               for f in fields if f.get("id")]
        return sorted(out, key=lambda f: f["name"].casefold())

    def jira_boards(self, _body: Any) -> list:
        boards = self._client().boards()
        out = [{"id": int(b["id"]), "name": str(b.get("name") or b["id"]), "type": str(b.get("type") or "")}
               for b in boards if isinstance(b.get("id"), int)]
        return sorted(out, key=lambda b: b["name"].casefold())

    def jira_pi_values(self, _body: Any) -> list:
        """Distinct values recently used in the PI field, as name suggestions."""
        field = clean_settings(self.db.get_settings())["jira"]["piField"]
        if not field:
            return []
        issues, _ = self._client().search(f"{field_ref(field)} is not EMPTY ORDER BY updated DESC", [field], limit=300)
        seen: dict[str, None] = {}
        for issue in issues:
            for text in text_values((issue.get("fields") or {}).get(field)):
                seen.setdefault(text)
        return sorted(seen, key=str.casefold, reverse=True)

    def jira_preview(self, body: Any) -> dict:
        if not isinstance(body, dict):
            raise ApiError(400, "Expected one of {source}, {auto}, {board} or {metric}.")
        if body.get("board") is not None:
            spec = normalize_board(body["board"])
            missing = "Pick a Jira board first."
        elif body.get("metric") is not None:
            spec = normalize_metric(body["metric"])
            missing = "Pick a metric and a board or a query first."
        elif body.get("auto") is not None:
            spec = normalize_auto(body["auto"])
            missing = "Enter a query first."
        else:
            spec = normalize_source(body.get("source"))
            missing = "Enter a Jira key, a Jira link or a query first."
        if spec is None:
            raise ApiError(400, missing)
        self._client()
        return self.syncer.engine().compute(spec)


# ---------- HTTP plumbing ----------

def make_handler(app: App):
    static_dir = app.cfg.static_dir

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "obeya"

        def log_message(self, fmt: str, *args: Any) -> None:
            log.debug("%s %s", self.address_string(), fmt % args)

        def do_GET(self) -> None:
            self._dispatch("GET")

        def do_PUT(self) -> None:
            self._dispatch("PUT")

        def do_POST(self) -> None:
            self._dispatch("POST")

        def _dispatch(self, method: str) -> None:
            path = urlsplit(self.path).path
            handler = app.routes.get((method, path))
            if handler is None and method != "GET":
                self.close_connection = True  # the body is left unread
            if not path.startswith("/api/"):
                if method == "GET":
                    self._static(path)
                else:
                    self._json(405, {"error": "Method not allowed."})
                return
            if handler is None:
                self._json(404, {"error": "No such endpoint."})
                return
            req = Request(None, self.headers)
            try:
                if method in ("PUT", "POST"):
                    req.body = self._body()
                if (method, path) not in app.open_routes and not app.access.describe(self.headers)["canEdit"]:
                    raise ApiError(401, "Editing is locked. Unlock it to make changes.")
                result = handler(req) if handler in app.wants_request else handler(req.body)
                self._json(200, result, req.set_cookies)
            except ApiError as err:
                self._json(err.status, {"error": str(err), **err.extra})
            except JiraUnavailable as err:
                self._json(502, {"error": str(err)})
            except JiraError as err:
                self._json(400, {"error": f"Jira could not run this: {err}"})
            except Exception:
                log.exception("Unhandled error on %s %s", method, path)
                self._json(500, {"error": "The server hit an unexpected error. Check the server log."})

        def _body(self) -> Any:
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                self.close_connection = True
                raise ApiError(400, "Bad Content-Length.")
            if length > MAX_BODY:
                self.close_connection = True
                raise ApiError(413, "That is too large to save.")
            raw = self.rfile.read(length) if length else b""
            # Only JSON is accepted. A form on another website cannot send JSON without the
            # browser asking this server first, which it never allows, so this (with the
            # SameSite cookie) is what stops another site from acting as an unlocked user.
            ctype = str(self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if ctype != "application/json":
                raise ApiError(415, "Send JSON (Content-Type: application/json).")
            if not raw:
                return None
            try:
                return json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                raise ApiError(400, "The request body is not valid JSON.")

        def _json(self, status: int, payload: Any, cookies: Optional[list] = None) -> None:
            body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            etag = '"' + hashlib.sha1(body).hexdigest()[:20] + '"'
            if status == 200 and self.command == "GET" and self.headers.get("If-None-Match") == etag:
                self.send_response(304)
                self.send_header("ETag", etag)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Content-Type-Options", "nosniff")
            for cookie in cookies or []:
                self.send_header("Set-Cookie", cookie)
            if status == 200 and self.command == "GET":
                self.send_header("ETag", etag)
            self.end_headers()
            self.wfile.write(body)

        def _static(self, path: str) -> None:
            target = _resolve_static(static_dir, path)
            if target is None:
                index = static_dir / "index.html"
                if not index.is_file():
                    self._plain(503, "The frontend has not been built yet. Run `npm run build` in frontend/.")
                    return
                target = index
            data = target.read_bytes()
            ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
                ctype += "; charset=utf-8"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            # Vite puts a content hash in asset names, so they can be cached for good.
            immutable = "/assets/" in path and target.name != "index.html"
            self.send_header("Cache-Control", "public, max-age=31536000, immutable" if immutable else "no-cache")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(data)

        def _plain(self, status: int, text: str) -> None:
            body = text.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


def _resolve_static(static_dir: Path, url_path: str) -> Optional[Path]:
    """Map a URL path to a file inside static_dir, or None (then index.html is served)."""
    rel = url_path.lstrip("/")
    if not rel:
        return None
    try:
        root = static_dir.resolve()
        target = (root / rel).resolve()
        target.relative_to(root)
    except (ValueError, OSError):
        return None
    return target if target.is_file() else None


def make_server(app: App) -> ThreadingHTTPServer:
    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("text/css", ".css")
    mimetypes.add_type("font/woff2", ".woff2")
    mimetypes.add_type("image/svg+xml", ".svg")
    server = ThreadingHTTPServer((app.cfg.host, app.cfg.port), make_handler(app))
    server.daemon_threads = True
    return server
