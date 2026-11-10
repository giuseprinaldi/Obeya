"""Read-only Jira REST client on the standard library.

Supports Data Center / Server (Bearer personal access token, REST v2) and
Cloud (Basic email + API token, the /rest/api/3/search/jql endpoint). Only
GET requests and the search POST are ever sent.
"""
from __future__ import annotations

import base64
import json
import logging
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

log = logging.getLogger("obeya.jira")

PAGE_SIZE = 100
FIELD_CACHE_SECONDS = 3600


class JiraError(Exception):
    """Jira answered, but refused this particular request (bad JQL, unknown issue)."""

    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.status = status


class JiraUnavailable(JiraError):
    """Jira cannot be used at all right now: network, TLS, auth, rate limit or 5xx."""


class _SameHostRedirects(urllib.request.HTTPRedirectHandler):
    """Refuse redirects to another host so the token is never forwarded elsewhere."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        old = urllib.parse.urlsplit(req.full_url)
        new = urllib.parse.urlsplit(newurl)
        if (old.scheme, old.netloc) != (new.scheme, new.netloc):
            raise urllib.error.HTTPError(newurl, code, "Redirect to a different host refused", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class JiraClient:
    def __init__(self, base_url: str, token: str, auth: str = "bearer", email: str = "",
                 ca_bundle: str = "", timeout: int = 30):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        if auth == "basic":
            raw = f"{email}:{token}".encode("utf-8")
            self._auth = "Basic " + base64.b64encode(raw).decode("ascii")
        else:
            self._auth = "Bearer " + token
        context = ssl.create_default_context(cafile=ca_bundle or None)
        # build_opener keeps the default ProxyHandler, so HTTPS_PROXY / NO_PROXY apply.
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=context), _SameHostRedirects())
        self._lock = threading.Lock()
        self._deployment: Optional[str] = None
        self._fields: Optional[list[dict]] = None
        self._fields_at = 0.0
        self._categories: Optional[dict[str, str]] = None
        self._categories_at = 0.0
        self._board_configs: dict[int, tuple[float, dict]] = {}

    # ---- transport ----

    def _request(self, method: str, path: str, params: Optional[dict] = None, body: Any = None) -> Any:
        url = self.base_url + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        data = None
        headers = {"Authorization": self._auth, "Accept": "application/json", "User-Agent": "obeya-sync"}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        last: Optional[Exception] = None
        for attempt in range(3):
            req = urllib.request.Request(url, data=data, headers=headers, method=method)
            try:
                with self._opener.open(req, timeout=self.timeout) as resp:
                    text = resp.read().decode("utf-8", "replace")
                    try:
                        return json.loads(text) if text.strip() else None
                    except ValueError:
                        # A login page or proxy notice instead of JSON.
                        raise JiraUnavailable("Jira returned something that is not JSON. Check the base URL "
                                              "and that the token is accepted.", resp.status)
            except urllib.error.HTTPError as err:
                message = _error_message(err)
                if err.code in (429, 502, 503, 504) and attempt < 2:
                    delay = _retry_after(err) or (1.5 * (attempt + 1))
                    time.sleep(min(delay, 20))
                    last = JiraUnavailable(f"Jira is busy or unavailable ({err.code}).", err.code)
                    continue
                if err.code == 401:
                    raise JiraUnavailable("Jira rejected the token (401). Check JIRA_TOKEN and JIRA_AUTH.", 401)
                if err.code == 403:
                    raise JiraUnavailable(f"Jira refused access (403). {message}".strip(), 403)
                if err.code == 429 or err.code >= 500:
                    raise JiraUnavailable(f"Jira is busy or unavailable ({err.code}).", err.code)
                raise JiraError(message or f"Jira returned {err.code}.", err.code)
            except (urllib.error.URLError, TimeoutError, ConnectionError, ssl.SSLError) as err:
                reason = getattr(err, "reason", err)
                last = JiraUnavailable(f"Could not reach Jira at {self.base_url}: {reason}")
                if attempt < 2:
                    time.sleep(1.0 * (attempt + 1))
                    continue
        assert last is not None
        raise last

    # ---- instance facts ----

    def server_info(self) -> dict:
        return self._request("GET", "/rest/api/2/serverInfo") or {}

    def is_cloud(self) -> bool:
        if self._deployment is None:
            info = self.server_info()
            self._deployment = str(info.get("deploymentType") or "Server")
        return self._deployment.lower() == "cloud"

    def fields(self) -> list[dict]:
        with self._lock:
            if self._fields is None or time.time() - self._fields_at > FIELD_CACHE_SECONDS:
                self._fields = self._request("GET", "/rest/api/2/field") or []
                self._fields_at = time.time()
            return self._fields

    def discovered_fields(self) -> dict:
        """Find the instance-specific ids of the fields the hierarchy walk needs."""
        found: dict[str, Optional[dict]] = {"epic_link": None, "parent_link": None, "story_points": None,
                                            "sprint": None, "flagged": None}
        named_points: Optional[dict] = None
        for f in self.fields():
            custom = str((f.get("schema") or {}).get("custom") or "")
            entry = {"id": f.get("id"), "name": f.get("name")}
            if custom.endswith(":gh-epic-link"):
                found["epic_link"] = entry
            elif custom.endswith(":jpo-custom-field-parent"):
                found["parent_link"] = entry
            elif custom.endswith(":jsw-story-points"):
                found["story_points"] = entry
            elif custom.endswith(":gh-sprint"):
                found["sprint"] = entry
            name = str(f.get("name") or "").strip().lower()
            if name == "flagged" and f.get("custom"):
                found["flagged"] = entry
            if name == "story points" or (name == "story point estimate" and named_points is None):
                named_points = entry
        if named_points and (found["story_points"] is None or str(named_points["name"]).lower() == "story points"):
            found["story_points"] = named_points
        return found

    def status_categories(self) -> dict[str, str]:
        """Status id -> category key ("new", "indeterminate" or "done"), for reading histories."""
        with self._lock:
            if self._categories is None or time.time() - self._categories_at > FIELD_CACHE_SECONDS:
                statuses = self._request("GET", "/rest/api/2/status") or []
                self._categories = {str(s.get("id")): str((s.get("statusCategory") or {}).get("key") or "")
                                    for s in statuses if s.get("id") is not None}
                self._categories_at = time.time()
            return self._categories

    # ---- search ----

    def search(self, jql: str, fields: list[str], limit: int = 2000, changelog: bool = False) -> tuple[list[dict], bool]:
        """Run a JQL search. Returns (issues, truncated)."""
        issues: list[dict] = []
        if self.is_cloud():
            token = None
            while True:
                body: dict[str, Any] = {"jql": jql, "maxResults": min(PAGE_SIZE, limit - len(issues)), "fields": fields}
                if changelog:
                    body["expand"] = "changelog"
                if token:
                    body["nextPageToken"] = token
                page = self._request("POST", "/rest/api/3/search/jql", body=body) or {}
                issues.extend(page.get("issues") or [])
                token = page.get("nextPageToken")
                if not token or page.get("isLast") or not page.get("issues"):
                    return issues, False
                if len(issues) >= limit:
                    return issues[:limit], True
        start = 0
        while True:
            body = {"jql": jql, "startAt": start, "maxResults": min(PAGE_SIZE, limit - len(issues)), "fields": fields}
            if changelog:
                body["expand"] = ["changelog"]
            page = self._request("POST", "/rest/api/2/search", body=body) or {}
            batch = page.get("issues") or []
            issues.extend(batch)
            total = int(page.get("total") or 0)
            start += len(batch)
            if not batch or start >= total:
                return issues, False
            if len(issues) >= limit:
                return issues[:limit], True

    # ---- agile ----

    def boards(self, limit: int = 300) -> list[dict]:
        out: list[dict] = []
        start = 0
        while len(out) < limit:
            page = self._request("GET", "/rest/agile/1.0/board", {"startAt": start, "maxResults": 50}) or {}
            values = page.get("values") or []
            out.extend(values)
            start += len(values)
            if not values or page.get("isLast", True):
                break
        return out

    def board_config(self, board_id: int) -> dict:
        """Name, type, columns (with their statuses and WIP limits) and sub-query of a board."""
        board_id = int(board_id)
        with self._lock:
            cached = self._board_configs.get(board_id)
            if cached and time.time() - cached[0] < 600:
                return cached[1]
        config = self._request("GET", f"/rest/agile/1.0/board/{board_id}/configuration") or {}
        with self._lock:
            self._board_configs[board_id] = (time.time(), config)
        return config

    def board_issues(self, board_id: int, jql: str, fields: list[str], limit: int = 1000,
                     changelog: bool = False) -> tuple[list[dict], bool]:
        """Issues on a board, in board order, optionally narrowed by JQL. Returns (issues, truncated)."""
        issues: list[dict] = []
        start = 0
        while True:
            params: dict[str, Any] = {"startAt": start, "maxResults": min(PAGE_SIZE, limit - len(issues)),
                                      "fields": ",".join(fields)}
            if jql:
                params["jql"] = jql
            if changelog:
                params["expand"] = "changelog"
            page = self._request("GET", f"/rest/agile/1.0/board/{int(board_id)}/issue", params) or {}
            batch = page.get("issues") or []
            issues.extend(batch)
            start += len(batch)
            if not batch or start >= int(page.get("total") or 0):
                return issues, False
            if len(issues) >= limit:
                return issues[:limit], True

    def active_sprint(self, board_id: int) -> Optional[dict]:
        page = self._request("GET", f"/rest/agile/1.0/board/{int(board_id)}/sprint", {"state": "active"}) or {}
        sprints = [s for s in (page.get("values") or []) if s.get("startDate") and s.get("endDate")]
        if not sprints:
            return None
        # With parallel sprints, follow the one that ends first.
        return sorted(sprints, key=lambda s: str(s.get("endDate")))[0]


def _error_message(err: urllib.error.HTTPError) -> str:
    try:
        payload = json.loads(err.read().decode("utf-8", "replace"))
    except Exception:
        return ""
    if not isinstance(payload, dict):
        return ""
    parts = [str(m) for m in (payload.get("errorMessages") or [])]
    errors = payload.get("errors")
    if isinstance(errors, dict):
        parts.extend(str(v) for v in errors.values())
    if not parts and payload.get("message"):
        parts.append(str(payload["message"]))
    return " ".join(parts).strip()


def _retry_after(err: urllib.error.HTTPError) -> float:
    try:
        return float(err.headers.get("Retry-After") or 0)
    except (TypeError, ValueError):
        return 0.0
