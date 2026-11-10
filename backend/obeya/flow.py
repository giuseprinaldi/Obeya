"""Flow maths: issue timelines, blocked rules, cycle and lead time, throughput.

Pure functions over Jira issue JSON (with its changelog where history is
needed). No I/O, so every rule here is unit-tested without a Jira.
"""
from __future__ import annotations

import math
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Optional

from .progress import _num

DAY = 86400.0


# ---------- reading Jira values ----------

def parse_ts(value: Any) -> Optional[datetime]:
    """Jira timestamps: 2026-11-02T09:15:30.000+0000 (also accepts +00:00 and Z)."""
    if not isinstance(value, str) or len(value) < 19:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+0000"
    text = re.sub(r"([+-]\d\d):(\d\d)$", r"\1\2", text)
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%dT%H:%M:%S%z"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    try:
        return datetime.strptime(text[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _ids(value: Any) -> frozenset[str]:
    """Sprint ids from a changelog value such as "12, 13"."""
    return frozenset(re.findall(r"\d+", str(value or "")))


def clean_blocked_rule(raw: Any) -> dict:
    raw = raw if isinstance(raw, dict) else {}

    def names(value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        return sorted({str(v).strip() for v in value if str(v).strip()})[:30]

    return {
        "flagged": raw.get("flagged", True) is not False,
        "statuses": names(raw.get("statuses")),
        "labels": names(raw.get("labels")),
        "links": raw.get("links") is True,
    }


def blocked_reason(raw: dict, rule: dict, flagged_field: str = "") -> str:
    """Why this issue counts as blocked right now, or "" when it does not."""
    fields = raw.get("fields") or {}
    if rule.get("flagged") and flagged_field and fields.get(flagged_field):
        return "Flagged"
    status = str((fields.get("status") or {}).get("name") or "")
    if status.casefold() in {s.casefold() for s in rule.get("statuses") or []}:
        return f"Status: {status}"
    wanted = {s.casefold() for s in rule.get("labels") or []}
    for label in fields.get("labels") or []:
        if str(label).casefold() in wanted:
            return f"Label: {label}"
    if rule.get("links"):
        for link in fields.get("issuelinks") or []:
            other = link.get("inwardIssue")
            inward = str((link.get("type") or {}).get("inward") or "").casefold()
            if not isinstance(other, dict) or "blocked by" not in inward:
                continue
            category = ((other.get("fields") or {}).get("status") or {}).get("statusCategory") or {}
            if category.get("key") != "done":
                return f"Blocked by {other.get('key')}"
    return ""


# ---------- timelines ----------

def timeline(raw: dict, categories: dict[str, str]) -> dict:
    """Reduce an issue and its changelog to the events flow maths needs.

    categories maps status id -> "new" | "indeterminate" | "done".
    """
    fields = raw.get("fields") or {}
    status = fields.get("status") or {}
    current = {"id": str(status.get("id") or ""), "name": str(status.get("name") or ""),
               "category": str((status.get("statusCategory") or {}).get("key") or "")}
    created = parse_ts(fields.get("created"))
    moves: list[dict] = []   # status changes
    flags: list[tuple[datetime, bool]] = []
    sprints: list[tuple[datetime, frozenset[str], frozenset[str]]] = []
    for history in ((raw.get("changelog") or {}).get("histories") or []):
        at = parse_ts(history.get("created"))
        if at is None:
            continue
        for item in history.get("items") or []:
            field = str(item.get("field") or "").casefold()
            if field == "status":
                to_id = str(item.get("to") or "")
                moves.append({
                    "at": at,
                    "from": {"name": str(item.get("fromString") or ""),
                             "category": categories.get(str(item.get("from") or ""), "")},
                    "to": {"name": str(item.get("toString") or ""), "category": categories.get(to_id, "")},
                })
            elif field == "flagged":
                flags.append((at, bool(str(item.get("toString") or "").strip())))
            elif field == "sprint":
                sprints.append((at, _ids(item.get("from")), _ids(item.get("to"))))
    moves.sort(key=lambda m: m["at"])
    flags.sort(key=lambda f: f[0])
    sprints.sort(key=lambda s: s[0])
    if created is None:
        created = moves[0]["at"] if moves else datetime.now(timezone.utc)
    first = moves[0]["from"] if moves else {"name": current["name"], "category": current["category"]}
    itype = fields.get("issuetype") or {}
    return {"key": str(raw.get("key") or ""), "created": created, "first": first, "moves": moves,
            "flags": flags, "sprints": sprints, "current": current,
            "type": str(itype.get("name") or ""), "subtask": bool(itype.get("subtask")),
            "labels": [str(l) for l in fields.get("labels") or []]}


def _is_done(state: dict, done_names: set[str]) -> bool:
    if done_names:
        return state["name"].casefold() in done_names
    return state["category"] == "done"


def _is_started(state: dict, done_names: set[str]) -> bool:
    """Work has begun: any status past "to do" that is not done."""
    return state["category"] in ("indeterminate", "done") and not _is_done(state, done_names)


def done_at(tl: dict, as_of: datetime, done_statuses: Optional[list[str]] = None) -> Optional[datetime]:
    """When the issue reached done and stayed there, looking only at history up to as_of.
    None if it was not done at as_of. Reopened work is not done until it is finished again."""
    done_names = {s.casefold() for s in done_statuses or []}
    since = tl["created"] if _is_done(tl["first"], done_names) else None
    for move in tl["moves"]:
        if move["at"] > as_of:
            break
        if _is_done(move["to"], done_names):
            if since is None:
                since = move["at"]
        else:
            since = None
    return since


def started_at(tl: dict, before: datetime, done_statuses: Optional[list[str]] = None) -> Optional[datetime]:
    """When work first began, or None if the issue went straight from to-do to done."""
    done_names = {s.casefold() for s in done_statuses or []}
    if _is_started(tl["first"], done_names):
        return tl["created"]
    for move in tl["moves"]:
        if move["at"] > before:
            break
        if _is_started(move["to"], done_names):
            return move["at"]
    return None


def blocked_seconds(tl: dict, start: datetime, end: datetime, rule: dict) -> float:
    """Seconds between start and end during which the issue was blocked, by the
    rules history can replay: the flag and blocked statuses."""
    if end <= start:
        return 0.0
    intervals: list[tuple[datetime, datetime]] = []
    if rule.get("flagged"):
        on: Optional[datetime] = None
        for at, flagged in tl["flags"]:
            if flagged and on is None:
                on = at
            elif not flagged and on is not None:
                intervals.append((on, at))
                on = None
        if on is not None:
            intervals.append((on, end))
    names = {s.casefold() for s in rule.get("statuses") or []}
    if names:
        state, since = tl["first"], tl["created"]
        for move in tl["moves"]:
            if state["name"].casefold() in names:
                intervals.append((since, move["at"]))
            state, since = move["to"], move["at"]
        if state["name"].casefold() in names:
            intervals.append((since, end))
    clipped = sorted((max(a, start), min(b, end)) for a, b in intervals if b > start and a < end)
    total, cursor = 0.0, start
    for a, b in clipped:        # union, so overlapping reasons are not counted twice
        a = max(a, cursor)
        if b > a:
            total += (b - a).total_seconds()
            cursor = b
    return total


def joined_sprint(tl: dict, sprint_id: str) -> datetime:
    """When the issue last joined the sprint. Issues created inside a sprint have
    no history for it, so they joined when they were created."""
    joined = tl["created"]
    for at, before, after in tl["sprints"]:
        if sprint_id in after and sprint_id not in before:
            joined = at
    return joined


# ---------- statistics ----------

def statistic(values: Iterable[float], kind: str) -> Optional[float]:
    data = sorted(values)
    if not data:
        return None
    if kind == "average":
        return sum(data) / len(data)
    if kind == "p85":
        return data[max(0, math.ceil(0.85 * len(data)) - 1)]
    mid = len(data) // 2
    return data[mid] if len(data) % 2 else (data[mid - 1] + data[mid]) / 2


def finished_in(timelines: list[dict], start: datetime, end: datetime,
                done_statuses: Optional[list[str]] = None) -> list[tuple[dict, datetime]]:
    """Issues that were done at `end` and reached done after `start`."""
    out = []
    for tl in timelines:
        at = done_at(tl, end, done_statuses)
        if at is not None and start < at <= end:
            out.append((tl, at))
    return out


def lookback_value(kind: str, timelines: list[dict], end: datetime, window_days: int, stat: str,
                   done_statuses: Optional[list[str]], rule: dict) -> tuple[Optional[float], int]:
    """One look-back metric as it stood at `end`. Returns (value, sample size)."""
    start = end - timedelta(days=window_days)
    if kind == "blocked_days":
        seconds = [blocked_seconds(tl, max(start, tl["created"]), end, rule) for tl in timelines]
        hit = [s for s in seconds if s > 0]
        return round(sum(hit) / DAY, 1), len(hit)
    finished = finished_in(timelines, start, end, done_statuses)
    if kind == "throughput":
        return round(len(finished) / (window_days / 7.0), 1), len(finished)
    days: list[float] = []
    for tl, at in finished:
        if kind == "lead_time":
            days.append((at - tl["created"]).total_seconds() / DAY)
        else:
            began = started_at(tl, at, done_statuses)
            if began is not None:
                days.append(max(0.0, (at - began).total_seconds() / DAY))
    value = statistic(days, stat)
    return (round(value, 1) if value is not None else None), len(days)


def burnup(items: list[tuple[dict, float]], moments: list[datetime],
           done_statuses: Optional[list[str]] = None) -> list[tuple[float, float]]:
    """(done, total) as they stood at each moment, replayed from history.

    items are (timeline, weight) pairs: weight is 1 when counting issues, or the
    story points. An issue counts towards the total from the moment it was
    created, and towards done while it was done. History does not say when an
    issue joined the scope or what its estimate used to be, so both are taken
    as they are today.
    """
    out = []
    for at in moments:
        done = total = 0.0
        for tl, weight in items:
            if tl["created"] > at:
                continue
            total += weight
            if done_at(tl, at, done_statuses) is not None:
                done += weight
        out.append((done, total))
    return out


def percent(part: float, whole: float) -> Optional[float]:
    return _num(round(100.0 * part / whole, 1)) if whole else None
