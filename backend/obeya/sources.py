"""Turn a Jira link into numbers: progress for an issue, query or auto-fill
query; columns and cards for a board; a value and trend for a flow metric."""
from __future__ import annotations

import hashlib
import json
import re
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Optional

from . import flow
from .jira_client import JiraClient, JiraError, JiraUnavailable
from .periods import TemplateError, resolve_jql, sprint_period
from .progress import empty_totals, issue_view, tally, work_items

KEY_RE = re.compile(r"[A-Z][A-Z0-9_]*-\d+")
MAX_DEPTH = 4          # initiative -> epic -> story -> sub-task, with one level spare
MAX_ISSUES = 5000      # per source; protects Jira and the sync from a runaway link
CHUNK = 40             # parent keys per "in (...)" query
JQL_LIMIT = 2000
BOARD_LIMIT = 1000     # issues on one flow board
CARDS_PER_COLUMN = 30  # cards sent to screens per column; the column total is always exact
HISTORY_WEEKS = 8      # weekly trend points for the look-back metrics

METRIC_KINDS = ("cycle_time", "lead_time", "throughput", "blocked_days",
                "scope_done", "wip", "blocked_now", "unplanned")
LOOKBACK = ("cycle_time", "lead_time", "throughput", "blocked_days")
STAT_LABEL = {"median": "Median", "average": "Average", "p85": "85th percentile"}


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
        if not jql:
            return None
        spec = {"kind": "jql", "jql": jql[:4000], **_options(raw)}
        # Only present when switched on, so links saved before the option existed keep
        # their id, and with it their history.
        if raw.get("descend") is True:
            spec["descend"] = True
        return spec
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


def _int(value: Any, default: int, lo: int, hi: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, number))


def _board_id(value: Any) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return None
    return value


def _names(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return sorted({str(v).strip() for v in value if str(v).strip()})[:50]


def normalize_board(raw: Any) -> Optional[dict]:
    """Validate a BoardSource. maxCards is display-only, so it is not part of the spec."""
    if not isinstance(raw, dict):
        return None
    board = _board_id(raw.get("boardId"))
    if board is None:
        return None
    return {
        "kind": "board",
        "boardId": board,
        "jql": str(raw.get("jql") or "").strip()[:4000],
        "sprint": "all" if raw.get("sprint") == "all" else "active",
        "hiddenColumns": _names(raw.get("hiddenColumns")),
        "doneDays": _int(raw.get("doneDays"), 14, 0, 365),
    }


def normalize_metric(raw: Any) -> Optional[dict]:
    """Validate a Metric. Only the options its kind uses go into the spec, so
    changing an option that does not apply does not cause a refetch."""
    if not isinstance(raw, dict) or raw.get("kind") not in METRIC_KINDS:
        return None
    kind = raw["kind"]
    board = _board_id(raw.get("boardId"))
    jql = str(raw.get("jql") or "").strip()[:4000]
    if board is None and not jql:
        return None
    options = _options(raw)
    spec: dict[str, Any] = {"kind": "metric", "metric": kind, "boardId": board, "jql": jql,
                            "doneStatuses": options["doneStatuses"]}
    if kind in LOOKBACK:
        spec["windowDays"] = _int(raw.get("windowDays"), 30, 7, 365)
    if kind in ("cycle_time", "lead_time"):
        spec["stat"] = raw.get("stat") if raw.get("stat") in STAT_LABEL else "median"
    if kind in ("scope_done", "wip", "unplanned"):
        spec["measure"] = options["measure"]
    if kind == "unplanned":
        rule = raw.get("unplanned") if isinstance(raw.get("unplanned"), dict) else {}
        if rule.get("rule") in ("labels", "types"):
            spec["unplanned"] = {"rule": rule["rule"], "values": _names(rule.get("values"))}
        else:
            spec["unplanned"] = {"rule": "added_after_start"}
    return spec


def is_lookback(spec: dict) -> bool:
    return spec.get("kind") == "metric" and spec.get("metric") in LOOKBACK


def spec_id(spec: dict) -> str:
    """Stable id for a spec. Identical links share one fetch and one history."""
    return hashlib.sha1(json.dumps(spec, sort_keys=True).encode("utf-8")).hexdigest()[:20]


def error_result(message: str, measure: str = "count") -> dict:
    return {"ok": False, "error": message, **empty_totals(measure), "history": [], "fetchedAt": _now()}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _without_order(jql: str) -> str:
    """Drop a trailing ORDER BY so the query can be wrapped in parentheses."""
    return re.sub(r"\s+ORDER\s+BY\s+.*$", "", jql.strip(), flags=re.I | re.S)


def _plural(n: Any, word: str) -> str:
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


# ---------- engine ----------

class Engine:
    """Computes specs against one Jira instance with one set of room settings."""

    def __init__(self, client: JiraClient, settings: dict, today: Optional[date] = None):
        self.client = client
        jira = settings.get("jira") or {}
        self.pi_field = str(jira.get("piField") or "")
        self.show_summaries = jira.get("showSummaries", True) is not False
        self.show_assignees = jira.get("showAssignees", True) is not False
        self.blocked_rule = flow.clean_blocked_rule(jira.get("blocked"))
        self.pis = settings.get("pis") or []
        self.today = today or date.today()
        found = client.discovered_fields()
        self.points_field = str(jira.get("storyPointsField") or "") or str((found["story_points"] or {}).get("id") or "")
        self.epic_link = found["epic_link"]
        self.parent_link = found["parent_link"]
        self.flagged_field = str((found.get("flagged") or {}).get("id") or "")
        self.sprint_field = str((found.get("sprint") or {}).get("id") or "")
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
            if spec["kind"] == "board":
                return self._board(spec)
            if spec["kind"] == "metric":
                return self._metric(spec)
            raise SourceError("Unknown kind of Jira link.")
        except JiraUnavailable:
            raise
        except (SourceError, TemplateError) as err:
            return self._failed(spec, str(err))
        except JiraError as err:
            return self._failed(spec, f"Jira could not run this: {err}")

    # ---- kinds ----

    def daily_history(self, spec: dict, first: date, last: date) -> list[tuple[date, float, float]]:
        """(day, done, total) for an issue or query link at the end of each day from
        first to last, replayed from the histories of the issues it covers today.

        Used once per burn-up chart, to fill in the days before the link existed.
        Raises SourceError or JiraError when the link cannot be read.
        """
        if last < first:
            return []
        fields = ["status", "issuetype", "created"] + ([self.points_field] if self.points_field else [])
        if spec["kind"] == "jql" and not spec.get("descend"):
            jql = resolve_jql(spec["jql"], self.pi_field, self.pis, self.today)
            raw, truncated = self.client.search(jql, fields, limit=JQL_LIMIT, changelog=True)
            if truncated:
                raise SourceError(f"This query matches more than {JQL_LIMIT} issues. Narrow it down.")
            if not spec["includeSubtasks"]:
                raw = [r for r in raw if not ((r.get("fields") or {}).get("issuetype") or {}).get("subtask")]
        elif spec["kind"] in ("issue", "jql"):
            # The work sits below what the link names, so find it first, then read its histories.
            if spec["kind"] == "issue":
                root = self._root(spec["key"])
                items = work_items(root, self._descend([root], spec["includeSubtasks"]))
            else:
                items = self._jql_items(spec)
            keys = [i["key"] for i in items]
            raw = []
            for i in range(0, len(keys), CHUNK):
                chunk = keys[i:i + CHUNK]
                found, _ = self.client.search(f"key in ({', '.join(chunk)})", fields, limit=len(chunk), changelog=True)
                raw.extend(found)
        else:
            raise SourceError("Only issue and query links have a daily history.")
        categories = self.client.status_categories()
        by_points = spec["measure"] == "points"
        items = []
        for r in raw:
            points = issue_view(r, self.points_field)["points"]
            items.append((flow.timeline(r, categories), float(points or 0) if by_points else 1.0))
        days = [first + timedelta(days=n) for n in range((last - first).days + 1)]
        # The end of a day is midnight in the server's own time zone, the same clock
        # that decides which day a snapshot belongs to.
        moments = [datetime.combine(day + timedelta(days=1), time.min).astimezone() for day in days]
        return [(day, done, total)
                for day, (done, total) in zip(days, flow.burnup(items, moments, spec["doneStatuses"]))]

    def _root(self, key: str) -> dict:
        try:
            raw, _ = self.client.search(f"key = {key}", self._fields, limit=1)
        except JiraUnavailable:
            raise
        except JiraError:
            raw = []
        if not raw:
            raise SourceError(f"{key} was not found in Jira, or the Jira account cannot see it.")
        return issue_view(raw[0], self.points_field)

    def _issue(self, spec: dict) -> dict:
        root = self._root(spec["key"])
        children = self._descend([root], spec["includeSubtasks"])
        return self._bar(root, children, spec)

    def _jql(self, spec: dict) -> dict:
        items = self._jql_items(spec)
        return {"ok": True, **tally(items, spec["measure"], spec["doneStatuses"]), "history": [], "fetchedAt": _now()}

    def _jql_items(self, spec: dict) -> list[dict]:
        """The issues a query link measures: its matches, or with "descend" the work
        under each match, found the same way as for an issue link. An issue reached
        from two matches (an epic and one of its own stories, say) counts once."""
        jql = resolve_jql(spec["jql"], self.pi_field, self.pis, self.today)
        raw, truncated = self.client.search(jql, self._fields, limit=JQL_LIMIT)
        if truncated:
            raise SourceError(f"This query matches more than {JQL_LIMIT} issues. Narrow it down.")
        items = [issue_view(r, self.points_field) for r in raw]
        if not spec["includeSubtasks"]:
            items = [i for i in items if not i["subtask"]]
        if not spec.get("descend"):
            return items
        children = self._descend(items, spec["includeSubtasks"])
        out: list[dict] = []
        seen: set[str] = set()
        for root in items:
            for item in work_items(root, children):
                if item["key"] not in seen:
                    seen.add(item["key"])
                    out.append(item)
        return out

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
        if spec["kind"] == "board":
            return {"ok": False, "error": message, "boardName": "", "boardType": "", "sprint": None,
                    "columns": [], "blocked": 0, "total": 0, "fetchedAt": _now()}
        if spec["kind"] == "metric":
            return {"ok": False, "error": message, "value": None, "unit": "", "n": 0, "detail": "",
                    "history": [], "fetchedAt": _now()}
        return error_result(message, spec.get("measure", "count"))

    # ---- flow boards and metrics ----

    def _flow_fields(self) -> list[str]:
        fields = ["summary", "status", "issuetype", "assignee", "labels", "issuelinks", "created",
                  "updated", "resolutiondate", "statuscategorychangedate"]
        for extra in (self.points_field, self.flagged_field, self.sprint_field):
            if extra and extra not in fields:
                fields.append(extra)
        return fields

    def _board_scope(self, board_id: int, extra_jql: str, sprint_mode: str,
                     use_subquery: bool) -> tuple[dict, str, Optional[dict]]:
        """Work out what a board shows. Returns (board config, JQL to narrow it, active sprint)."""
        try:
            config = self.client.board_config(board_id)
        except JiraUnavailable:
            raise
        except JiraError:
            raise SourceError(f"Board {board_id} was not found in Jira, or the Jira account cannot see it.")
        clauses: list[str] = []
        sprint: Optional[dict] = None
        scrum = str(config.get("type") or "").lower() == "scrum"
        if scrum and sprint_mode == "active":
            try:
                sprint = self.client.active_sprint(board_id)
            except JiraUnavailable:
                raise
            except JiraError:
                sprint = None
            if not sprint or sprint.get("id") is None:
                raise SourceError("This board has no active sprint right now.")
            clauses.append(f"sprint = {int(sprint['id'])}")
        sub_query = str((config.get("subQuery") or {}).get("query") or "").strip()
        if use_subquery and sub_query and not scrum:
            clauses.append(f"({_without_order(sub_query)})")
        if extra_jql:
            clauses.append(f"({_without_order(resolve_jql(extra_jql, self.pi_field, self.pis, self.today))})")
        return config, " AND ".join(clauses), sprint

    def _card(self, raw: dict, view: dict, now: datetime) -> dict:
        fields = raw.get("fields") or {}
        reason = flow.blocked_reason(raw, self.blocked_rule, self.flagged_field)
        changed = flow.parse_ts(fields.get("statuscategorychangedate"))
        assignee = fields.get("assignee") if isinstance(fields.get("assignee"), dict) else {}
        return {
            "key": view["key"],
            "title": view["summary"] if self.show_summaries else view["key"],
            "url": f"{self.client.base_url}/browse/{view['key']}",
            "type": view["type"],
            "assignee": str(assignee.get("displayName") or "") if self.show_assignees else "",
            "status": view["status"],
            "points": view["points"],
            "blocked": bool(reason),
            "blockedReason": reason,
            "ageDays": max(0, (now - changed).days) if changed else None,
        }

    def _board(self, spec: dict) -> dict:
        config, jql, sprint = self._board_scope(spec["boardId"], spec["jql"], spec["sprint"], True)
        raw, truncated = self.client.board_issues(spec["boardId"], jql, self._flow_fields(), limit=BOARD_LIMIT)
        if truncated:
            raise SourceError(f"This board shows more than {BOARD_LIMIT} issues. Narrow it with a query.")
        board_columns = (config.get("columnConfig") or {}).get("columns") or []
        if not board_columns:
            raise SourceError("This board has no columns set up in Jira.")
        hidden = {name.casefold() for name in spec["hiddenColumns"]}
        columns: list[dict] = []
        by_status: dict[str, Optional[dict]] = {}
        for index, col in enumerate(board_columns):
            name = str(col.get("name") or "")
            try:
                wip = max(0, int(col.get("max") or 0))
            except (TypeError, ValueError):
                wip = 0
            entry = {"name": name, "wip": wip, "total": 0, "cards": [], "last": index == len(board_columns) - 1}
            visible = name.casefold() not in hidden
            if visible:
                columns.append(entry)
            for status in col.get("statuses") or []:
                by_status[str(status.get("id"))] = entry if visible else None
        now = datetime.now(timezone.utc)
        blocked = 0
        for r in raw:
            view = issue_view(r, self.points_field)
            if view["subtask"]:
                continue
            fields = r.get("fields") or {}
            column = by_status.get(str((fields.get("status") or {}).get("id")))
            if column is None:
                continue
            finished = None
            if column["last"]:
                finished = flow.parse_ts(fields.get("resolutiondate")) or flow.parse_ts(fields.get("statuscategorychangedate"))
                if spec["doneDays"] and finished and now - finished > timedelta(days=spec["doneDays"]):
                    continue
            card = self._card(r, view, now)
            column["total"] += 1
            column["cards"].append((finished, card))
            if card["blocked"] and not column["last"]:
                blocked += 1
        out_columns = []
        for column in columns:
            cards = column["cards"]
            if column["last"]:   # newest finished work first
                cards = sorted(cards, key=lambda c: c[0] or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
            out_columns.append({"name": column["name"], "wip": column["wip"], "total": column["total"],
                                "cards": [card for _, card in cards[:CARDS_PER_COLUMN]]})
        return {
            "ok": True,
            "boardName": str(config.get("name") or f"Board {spec['boardId']}"),
            "boardType": str(config.get("type") or "").lower(),
            "sprint": sprint_period(sprint),
            "columns": out_columns,
            "blocked": blocked,
            "total": sum(c["total"] for c in out_columns),
            "fetchedAt": _now(),
        }

    def _metric(self, spec: dict) -> dict:
        kind = spec["metric"]
        lookback = kind in LOOKBACK
        rule = spec.get("unplanned") or {}
        by_join_date = kind == "unplanned" and rule.get("rule") == "added_after_start"
        if kind == "blocked_days" and not (self.blocked_rule["flagged"] or self.blocked_rule["statuses"]):
            raise SourceError("Blocked days can only replay the flag and blocked statuses. "
                              "Turn one of them on under \"Blocked means\" in Jira settings.")
        sprint: Optional[dict] = None
        if spec["boardId"]:
            # Right-now metrics follow the active sprint; look-back metrics need finished work too.
            _, jql, sprint = self._board_scope(spec["boardId"], spec["jql"],
                                               "all" if lookback else "active", use_subquery=not lookback)
        else:
            jql = _without_order(resolve_jql(spec["jql"], self.pi_field, self.pis, self.today))
        if by_join_date and not sprint:
            raise SourceError("The \"added after the sprint started\" rule needs a scrum board with an "
                              "active sprint. Pick a board, or use a label or issue type rule.")
        if lookback:
            span = spec["windowDays"] + 7 * (HISTORY_WEEKS - 1) + 1
            recent = f"updated >= -{span}d"
            if kind == "blocked_days":   # something flagged long ago and untouched since is still blocked
                recent = f"(statusCategory != Done OR {recent})"
            jql = f"({jql}) AND {recent}" if jql else recent
        changelog = lookback or by_join_date
        if spec["boardId"]:
            raw, truncated = self.client.board_issues(spec["boardId"], jql, self._flow_fields(),
                                                      limit=JQL_LIMIT, changelog=changelog)
        else:
            raw, truncated = self.client.search(jql, self._flow_fields(), limit=JQL_LIMIT, changelog=changelog)
        if truncated:
            raise SourceError(f"This scope covers more than {JQL_LIMIT} issues. Narrow it down.")
        raw = [r for r in raw if not ((r.get("fields") or {}).get("issuetype") or {}).get("subtask")]
        if lookback:
            return self._lookback(spec, raw)
        return self._snapshot(spec, raw, sprint)

    def _lookback(self, spec: dict, raw: list[dict]) -> dict:
        kind, window = spec["metric"], spec["windowDays"]
        categories = self.client.status_categories()
        timelines = [flow.timeline(r, categories) for r in raw]
        now = datetime.now(timezone.utc)
        history = []
        value: Optional[float] = None
        n = 0
        for weeks_ago in range(HISTORY_WEEKS - 1, -1, -1):
            end = now - timedelta(days=7 * weeks_ago)
            value, n = flow.lookback_value(kind, timelines, end, window, spec.get("stat", "median"),
                                           spec["doneStatuses"], self.blocked_rule)
            if value is not None:
                history.append({"d": end.date().isoformat(), "value": value})
        if kind == "throughput":
            unit, detail = "/ week", f"{_plural(n, 'item')} finished in the last {window} days"
        elif kind == "blocked_days":
            unit = "days"
            detail = (f"{_plural(n, 'item')} blocked at some point in the last {window} days" if n
                      else f"Nothing was blocked in the last {window} days")
        else:
            unit = "days"
            what = "start to done" if kind == "cycle_time" else "created to done"
            detail = (f"{STAT_LABEL[spec['stat']]} {what} for {_plural(n, 'item')} finished in the last {window} days"
                      if n else f"No work finished in the last {window} days")
        return {"ok": True, "value": value, "unit": unit, "n": n, "detail": detail,
                "history": history, "fetchedAt": _now()}

    def _snapshot(self, spec: dict, raw: list[dict], sprint: Optional[dict]) -> dict:
        kind = spec["metric"]
        measure = spec.get("measure", "count")
        views = [issue_view(r, self.points_field) for r in raw]
        totals = tally(views, measure, spec["doneStatuses"])
        unit_word = "points" if measure == "points" else "issues"
        short = "pts" if measure == "points" else "items"
        custom_done = {s.casefold() for s in spec["doneStatuses"]}

        def is_done(view: dict) -> bool:
            return view["status"].casefold() in custom_done if custom_done else view["category"] == "done"

        def weight(view: dict) -> float:
            return float(view["points"] or 0) if measure == "points" else 1.0

        if kind == "scope_done":
            value = flow.percent(totals["done"], totals["total"])
            detail = (f"{totals['done']} of {totals['total']} {unit_word} done" if totals["total"]
                      else "Nothing in scope yet")
            unit = "%"
        elif kind == "wip":
            value = totals["inProgress"]
            detail = f"{_plural(sum(1 for v in views if not is_done(v) and v['category'] != 'new'), 'item')} in progress"
            unit = short
        elif kind == "blocked_now":
            open_items = [(r, v) for r, v in zip(raw, views) if not is_done(v)]
            hit = [v["key"] for r, v in open_items if flow.blocked_reason(r, self.blocked_rule, self.flagged_field)]
            value = len(hit)
            detail = f"{len(hit)} of {_plural(len(open_items), 'open item')} blocked"
            if hit:
                detail += ": " + ", ".join(hit[:5]) + (" and more" if len(hit) > 5 else "")
            unit = "items"
        else:   # unplanned
            rule = spec["unplanned"]
            if rule["rule"] == "added_after_start":
                assert sprint is not None
                start = flow.parse_ts(sprint.get("startDate"))
                if start is None:
                    raise SourceError("The active sprint has no start date in Jira.")
                sprint_id = str(sprint["id"])
                categories = self.client.status_categories()
                flags = [flow.joined_sprint(flow.timeline(r, categories), sprint_id).date() > start.date() for r in raw]
                how = "added after the sprint started"
            elif rule["rule"] == "labels":
                wanted = {v.casefold() for v in rule["values"]}
                flags = [any(str(l).casefold() in wanted for l in (r.get("fields") or {}).get("labels") or []) for r in raw]
                how = "labelled " + ", ".join(rule["values"]) if rule["values"] else "matching (no labels chosen)"
            else:
                wanted = {v.casefold() for v in rule["values"]}
                flags = [v["type"].casefold() in wanted for v in views]
                how = "of type " + ", ".join(rule["values"]) if rule["values"] else "matching (no types chosen)"
            part = sum(weight(v) for v, f in zip(views, flags) if f)
            whole = sum(weight(v) for v in views)
            value = flow.percent(part, whole)
            detail = f"{sum(flags)} of {_plural(len(views), 'item')} {how}" if views else "Nothing in scope yet"
            unit = "%"
        return {"ok": True, "value": value, "unit": unit, "n": len(views), "detail": detail,
                "history": [], "fetchedAt": _now()}

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
