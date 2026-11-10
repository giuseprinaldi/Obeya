"""Turn a Jira link (issue, query or auto-fill query) into progress numbers."""
from __future__ import annotations

import hashlib
import json
import re
from datetime import date, datetime, timezone
from typing import Any, Optional

from .jira_client import JiraClient, JiraError, JiraUnavailable
from .periods import TemplateError, resolve_jql
from .progress import empty_totals, issue_view, tally, work_items

KEY_RE = re.compile(r"[A-Z][A-Z0-9_]*-\d+")
MAX_DEPTH = 4          # initiative -> epic -> story -> sub-task, with one level spare
MAX_ISSUES = 5000      # per source; protects Jira and the sync from a runaway link
CHUNK = 40             # parent keys per "in (...)" query
JQL_LIMIT = 2000


class SourceError(Exception):
    """This link cannot be computed; the message is shown on the bar."""


# ---------- specs ----------

def normalize_key(value: Any) -> str:
    """Accept PLAT-12, plat-12 or a pasted Jira URL."""
    text = str(value or "").strip().upper()
    in_url = re.search(r"(?:/BROWSE/|SELECTEDISSUE=)(" + KEY_RE.pattern + r")", text)
    if in_url:
        return in_url.group(1)
    found = KEY_RE.findall(text)
    return found[-1] if found else ""


def _options(raw: dict) -> dict:
    statuses = raw.get("doneStatuses")
    cleaned = sorted({str(s).strip() for s in statuses if str(s).strip()}) if isinstance(statuses, list) else []
    return {
        "measure": "points" if raw.get("measure") == "points" else "count",
        "includeSubtasks": bool(raw.get("includeSubtasks")),
        "doneStatuses": cleaned[:30],
    }


def normalize_source(raw: Any) -> Optional[dict]:
    """Validate a Source from the room document. None = not a Jira link."""
    if not isinstance(raw, dict):
        return None
    if raw.get("kind") == "issue":
        key = normalize_key(raw.get("key"))
        return {"kind": "issue", "key": key, **_options(raw)} if key else None
    if raw.get("kind") == "jql":
        jql = str(raw.get("jql") or "").strip()
        return {"kind": "jql", "jql": jql[:4000], **_options(raw)} if jql else None
    return None


def normalize_auto(raw: Any) -> Optional[dict]:
    if not isinstance(raw, dict):
        return None
    jql = str(raw.get("jql") or "").strip()
    if not jql:
        return None
    try:
        limit = int(raw.get("limit") or 12)
    except (TypeError, ValueError):
        limit = 12
    return {"kind": "auto", "jql": jql[:4000], "limit": max(1, min(100, limit)), **_options(raw)}


def spec_id(spec: dict) -> str:
    """Stable id for a spec. Identical links share one fetch and one history."""
    return hashlib.sha1(json.dumps(spec, sort_keys=True).encode("utf-8")).hexdigest()[:20]


def error_result(message: str, measure: str = "count") -> dict:
    return {"ok": False, "error": message, **empty_totals(measure), "history": [], "fetchedAt": _now()}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------- engine ----------

class Engine:
    """Computes specs against one Jira instance with one set of room settings."""

    def __init__(self, client: JiraClient, settings: dict, today: Optional[date] = None):
        self.client = client
        jira = settings.get("jira") or {}
        self.pi_field = str(jira.get("piField") or "")
        self.show_summaries = jira.get("showSummaries", True) is not False
        self.pis = settings.get("pis") or []
        self.today = today or date.today()
        found = client.discovered_fields()
        self.points_field = str(jira.get("storyPointsField") or "") or str((found["story_points"] or {}).get("id") or "")
        self.epic_link = found["epic_link"]
        self.parent_link = found["parent_link"]
        self.cloud = client.is_cloud()
        self._fields = ["summary", "status", "issuetype", "parent"]
        for extra in (self.points_field, (self.epic_link or {}).get("id"), (self.parent_link or {}).get("id")):
            if extra and extra not in self._fields:
                self._fields.append(extra)
        self._unsupported: set[str] = set()   # hierarchy clauses this Jira rejects
        self._one_by_one: set[str] = set()    # clauses whose parent pointer cannot be read

    # ---- public ----

    def compute(self, spec: dict) -> dict:
        """Never raises SourceError: a broken link becomes an error result.
        JiraUnavailable does propagate, so callers can keep the last good data."""
        try:
            if spec["kind"] == "issue":
                return self._issue(spec)
            if spec["kind"] == "jql":
                return self._jql(spec)
            if spec["kind"] == "auto":
                return self._auto(spec)
            raise SourceError("Unknown kind of Jira link.")
        except JiraUnavailable:
            raise
        except (SourceError, TemplateError) as err:
            return self._failed(spec, str(err))
        except JiraError as err:
            return self._failed(spec, f"Jira could not run this: {err}")

    # ---- kinds ----

    def _issue(self, spec: dict) -> dict:
        key = spec["key"]
        try:
            raw, _ = self.client.search(f"key = {key}", self._fields, limit=1)
        except JiraUnavailable:
            raise
        except JiraError:
            raw = []
        if not raw:
            raise SourceError(f"{key} was not found in Jira, or the Jira account cannot see it.")
        root = issue_view(raw[0], self.points_field)
        children = self._descend([root], spec["includeSubtasks"])
        return self._bar(root, children, spec)

    def _jql(self, spec: dict) -> dict:
        jql = resolve_jql(spec["jql"], self.pi_field, self.pis, self.today)
        raw, truncated = self.client.search(jql, self._fields, limit=JQL_LIMIT)
        if truncated:
            raise SourceError(f"This query matches more than {JQL_LIMIT} issues. Narrow it down.")
        items = [issue_view(r, self.points_field) for r in raw]
        if not spec["includeSubtasks"]:
            items = [i for i in items if not i["subtask"]]
        return {"ok": True, **tally(items, spec["measure"], spec["doneStatuses"]), "history": [], "fetchedAt": _now()}

    def _auto(self, spec: dict) -> dict:
        jql = resolve_jql(spec["jql"], self.pi_field, self.pis, self.today)
        raw, truncated = self.client.search(jql, self._fields, limit=spec["limit"])
        roots = [issue_view(r, self.points_field) for r in raw]
        children = self._descend(roots, spec["includeSubtasks"])
        return {"ok": True, "bars": [self._bar(r, children, spec) for r in roots],
                "truncated": truncated, "fetchedAt": _now()}

    def _bar(self, root: dict, children: dict[str, list[dict]], spec: dict) -> dict:
        totals = tally(work_items(root, children), spec["measure"], spec["doneStatuses"])
        return {
            "ok": True,
            "key": root["key"],
            "title": root["summary"] if self.show_summaries else root["key"],
            "url": f"{self.client.base_url}/browse/{root['key']}",
            "issueType": root["type"],
            "status": root["status"],
            **totals,
            "history": [],
            "fetchedAt": _now(),
        }

    def _failed(self, spec: dict, message: str) -> dict:
        if spec["kind"] == "auto":
            return {"ok": False, "error": message, "bars": [], "truncated": False, "fetchedAt": _now()}
        return error_result(message, spec.get("measure", "count"))

    # ---- hierarchy ----

    def _clauses(self, include_subtasks: bool) -> list[tuple[str, str, str]]:
        """(name, JQL field, issue field holding the parent pointer) for each way
        Jira links a child to its parent."""
        out = []
        if self.epic_link:
            out.append(("epic", _quote(self.epic_link["name"]), self.epic_link["id"]))
        if self.parent_link:
            out.append(("parentlink", _quote(self.parent_link["name"]), self.parent_link["id"]))
        # On Data Center "parent" only reaches sub-tasks. On Cloud it is the whole hierarchy.
        if self.cloud or include_subtasks:
            out.append(("parent", "parent", "parent"))
        return [c for c in out if c[0] not in self._unsupported]

    def _descend(self, roots: list[dict], include_subtasks: bool) -> dict[str, list[dict]]:
        """Breadth-first walk below the roots. Returns parent key -> children."""
        children: dict[str, list[dict]] = {}
        by_key = {r["key"]: r for r in roots}
        frontier = [r for r in roots if not r["subtask"]]
        for _ in range(MAX_DEPTH):
            if not frontier:
                break
            found = self._children_of(frontier, include_subtasks)
            nxt = []
            for parent, kids in found.items():
                fresh = [k for k in kids if k["key"] != parent]
                if not fresh:
                    continue
                children.setdefault(parent, [])
                have = {c["key"] for c in children[parent]}
                for kid in fresh:
                    if kid["key"] in have:
                        continue
                    children[parent].append(kid)
                    have.add(kid["key"])
                    if kid["key"] not in by_key:
                        by_key[kid["key"]] = kid
                        if not kid["subtask"]:
                            nxt.append(kid)
            if len(by_key) > MAX_ISSUES:
                raise SourceError(f"This link covers more than {MAX_ISSUES} issues. Link something smaller.")
            frontier = nxt
        return children

    def _children_of(self, parents: list[dict], include_subtasks: bool) -> dict[str, list[dict]]:
        out: dict[str, list[dict]] = {}
        for name, jql_field, pointer_field in self._clauses(include_subtasks):
            size = 1 if name in self._one_by_one else CHUNK
            i = 0
            while i < len(parents):
                chunk = parents[i:i + size]
                keys = [p["key"] for p in chunk]
                try:
                    raw, _ = self.client.search(f"{jql_field} in ({', '.join(keys)})", self._fields, limit=MAX_ISSUES)
                except JiraUnavailable:
                    raise
                except JiraError:
                    # This Jira has no such link type (for example no Advanced Roadmaps).
                    self._unsupported.add(name)
                    break
                lookup = {p["key"]: p["key"] for p in chunk}
                lookup.update({p["id"]: p["key"] for p in chunk if p["id"]})
                unresolved = False
                batch: dict[str, list[dict]] = {}
                for r in raw:
                    view = issue_view(r, self.points_field)
                    if view["subtask"] and not include_subtasks:
                        continue
                    parent = _pointer((r.get("fields") or {}).get(pointer_field), lookup)
                    if parent is None:
                        if len(chunk) == 1:
                            parent = keys[0]
                        else:
                            unresolved = True
                            break
                    batch.setdefault(parent, []).append(view)
                if unresolved:
                    # Cannot tell which parent each child belongs to; ask one parent at a time.
                    self._one_by_one.add(name)
                    size = 1
                    continue
                for parent, kids in batch.items():
                    out.setdefault(parent, []).extend(kids)
                i += size
        return out


def _quote(name: str) -> str:
    return '"' + str(name).replace("\\", "\\\\").replace('"', '\\"') + '"'


def _pointer(value: Any, lookup: dict[str, str]) -> Optional[str]:
    """Read a parent reference in any of the shapes Jira uses: a key, an id,
    or an object carrying one of them."""
    candidates: list[Any] = []
    if isinstance(value, (str, int)):
        candidates.append(value)
    elif isinstance(value, dict):
        data = value.get("data") if isinstance(value.get("data"), dict) else {}
        candidates.extend([value.get("key"), value.get("id"), data.get("key"), data.get("id")])
    for c in candidates:
        if c is not None and str(c) in lookup:
            return lookup[str(c)]
    return None


def text_values(value: Any) -> list[str]:
    """Flatten a field value (string, option, version, or a list of those) to text."""
    if value is None:
        return []
    if isinstance(value, list):
        out: list[str] = []
        for v in value:
            out.extend(text_values(v))
        return out
    if isinstance(value, dict):
        for k in ("value", "name"):
            if value.get(k) not in (None, ""):
                return [str(value[k])]
        return []
    text = str(value).strip()
    return [text] if text else []
