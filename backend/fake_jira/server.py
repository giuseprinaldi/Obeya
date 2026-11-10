"""HTTP server for the fake Jira. Run it with: python -m fake_jira"""
from __future__ import annotations

import json
import os
import re
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional
from urllib.parse import parse_qs, urlsplit

from .data import PI_FIELD, STATUSES, STORY_POINTS, Dataset, FIELDS, status_json
from .jql import JqlError, search

DEFAULT_TOKEN = "fake-token"


def make_fake_server(host: str = "127.0.0.1", port: int = 8790, token: str = DEFAULT_TOKEN,
                     today: Optional[date] = None, parent_link_shape: str = "key",
                     hide_fields: tuple = (), changelog: bool = True) -> ThreadingHTTPServer:
    """Options that imitate the ways real Jira instances differ:

    parent_link_shape  "key" returns the Parent Link as an issue key; "opaque" returns
                       an object with no usable reference.
    hide_fields        field ids this instance does not have (left out of the field
                       list and of every issue).
    changelog          False = searches ignore expand=changelog.
    """
    dataset = Dataset(today)
    hidden = set(hide_fields)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args: Any) -> None:
            pass

        def _send(self, status: int, payload: Any) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json;charset=UTF-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _base(self) -> str:
            return f"http://{self.headers.get('Host') or f'{host}:{port}'}"

        def _handle(self, method: str) -> None:
            server.requests += 1
            split = urlsplit(self.path)
            query = {k: v[0] for k, v in parse_qs(split.query).items()}
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}") if length else {}
            if self.headers.get("Authorization") != f"Bearer {token}":
                self._send(401, {"errorMessages": ["You are not authenticated."], "errors": {}})
                return
            path = split.path.rstrip("/")
            if method == "GET" and path == "/rest/api/2/serverInfo":
                self._send(200, {"baseUrl": self._base(), "version": "9.12.4", "deploymentType": "Server",
                                 "serverTitle": "Fake Jira"})
            elif method == "GET" and path == "/rest/api/2/myself":
                self._send(200, {"name": "svc-obeya", "displayName": "Obeya service account", "active": True})
            elif method == "GET" and path == "/rest/api/2/field":
                self._send(200, [f for f in FIELDS if f["id"] not in hidden])
            elif method == "GET" and path == "/rest/api/2/status":
                self._send(200, [status_json(name) for name in STATUSES])
            elif path == "/rest/api/2/search":
                self._search({**query, **body} if method == "POST" else query)
            elif method == "GET" and (m := re.fullmatch(r"/rest/agile/1\.0/board/(\d+)/configuration", path)):
                config = dataset.board_config(int(m.group(1)))
                if config is None:
                    self._send(404, {"errorMessages": ["Board does not exist or you do not have permission to see it."], "errors": {}})
                else:
                    self._send(200, config)
            elif method == "GET" and (m := re.fullmatch(r"/rest/agile/1\.0/board/(\d+)/issue", path)):
                project = dataset.board_project(int(m.group(1)))
                if project is None:
                    self._send(404, {"errorMessages": ["Board does not exist or you do not have permission to see it."], "errors": {}})
                else:
                    extra = str(query.get("jql") or "").strip()
                    jql = f"project = {project}" + (f" AND ({extra})" if extra else "")
                    self._search({**query, "jql": jql})
            elif method == "GET" and path == "/rest/agile/1.0/board":
                self._send(200, {"maxResults": 50, "startAt": 0, "isLast": True, "values": dataset.boards})
            elif method == "GET" and (m := re.fullmatch(r"/rest/agile/1\.0/board/(\d+)/sprint", path)):
                if int(m.group(1)) != 1:
                    self._send(400, {"errorMessages": ["The board does not support sprints"], "errors": {}})
                    return
                state = query.get("state")
                values = [s for s in dataset.sprints if not state or s["state"] in state.split(",")]
                self._send(200, {"maxResults": 50, "startAt": 0, "isLast": True, "values": values})
            else:
                self._send(404, {"errorMessages": ["Not found"], "errors": {}})

        def _search(self, args: dict) -> None:
            try:
                matches = search(dataset, str(args.get("jql") or ""))
            except JqlError as err:
                self._send(400, {"errorMessages": [str(err)], "errors": {}})
                return
            start = int(args.get("startAt") or 0)
            size = max(0, min(int(args.get("maxResults") or 50), 100))
            fields = args.get("fields")
            if isinstance(fields, str):
                fields = fields.split(",")
            expand = args.get("expand") or ""
            if isinstance(expand, list):
                expand = ",".join(expand)
            page = []
            for issue in matches[start:start + size]:
                item = dataset.to_json(issue, self._base(), fields, changelog=changelog and "changelog" in expand)
                for name in hidden:
                    item["fields"].pop(name, None)
                if parent_link_shape == "opaque":
                    for name, value in item["fields"].items():
                        if name == "customfield_10102" and value:
                            item["fields"][name] = {"showField": True, "hasEpicLinkFieldDependency": False}
                page.append(item)
            self._send(200, {"startAt": start, "maxResults": size, "total": len(matches), "issues": page})

        def do_GET(self) -> None:
            self._handle("GET")

        def do_POST(self) -> None:
            self._handle("POST")

    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    server.dataset = dataset  # type: ignore[attr-defined]
    server.requests = 0  # type: ignore[attr-defined]
    return server


def suggested_settings(dataset: Dataset) -> dict:
    """Obeya settings that match this fake instance."""
    return {
        "jira": {"piField": PI_FIELD, "storyPointsField": STORY_POINTS, "boardId": 1, "showSummaries": True,
                 "showAssignees": True,
                 "blocked": {"flagged": True, "statuses": [], "labels": [], "links": True}},
        "pis": dataset.pis,
    }


def main() -> None:
    port = int(os.environ.get("FAKE_JIRA_PORT") or 8790)
    token = os.environ.get("FAKE_JIRA_TOKEN") or DEFAULT_TOKEN
    server = make_fake_server(port=port, token=token)
    print(f"Fake Jira on http://127.0.0.1:{port}  (token: {token})")
    print(f"{len(server.dataset.issues)} issues, try PLAT-1 or DATA-1")  # type: ignore[attr-defined]
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
