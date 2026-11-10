"""Progress maths. Pure functions over simplified issue records, no I/O."""
from __future__ import annotations

from typing import Any, Iterable, Optional


def issue_view(raw: dict, points_field: str = "") -> dict:
    """Reduce a Jira issue to the handful of values progress needs."""
    fields = raw.get("fields") or {}
    status = fields.get("status") or {}
    category = (status.get("statusCategory") or {}).get("key") or ""
    itype = fields.get("issuetype") or {}
    points = fields.get(points_field) if points_field else None
    if isinstance(points, bool) or not isinstance(points, (int, float)):
        points = None
    return {
        "key": str(raw.get("key") or ""),
        "id": str(raw.get("id") or ""),
        "summary": str(fields.get("summary") or ""),
        "type": str(itype.get("name") or ""),
        "subtask": bool(itype.get("subtask")),
        "status": str(status.get("name") or ""),
        "category": str(category),  # "new", "indeterminate" or "done"
        "points": points,
    }


def work_items(root: dict, children: dict[str, list[dict]]) -> list[dict]:
    """The issues that count towards a root's progress.

    Anything with children is a container and is replaced by its children, to
    any depth. Anything without children counts as itself, so an epic with no
    stories yet shows as one open item rather than as nothing.
    """
    out: list[dict] = []
    seen: set[str] = set()
    stack = [root]
    while stack:
        node = stack.pop()
        if node["key"] in seen:
            continue
        seen.add(node["key"])
        kids = children.get(node["key"]) or []
        if kids:
            stack.extend(reversed(kids))
        else:
            out.append(node)
    return out


def tally(items: Iterable[dict], measure: str, done_statuses: Optional[list[str]] = None) -> dict:
    """Add up done, in progress and to do, by issue count or by story points.

    done_statuses overrides Jira's status category: when given, only those
    status names count as done.
    """
    custom_done = {s.strip().casefold() for s in (done_statuses or []) if s and s.strip()}
    by_points = measure == "points"
    done = in_progress = todo = 0.0
    count = unestimated = 0
    by_status: dict[str, int] = {}
    for item in items:
        count += 1
        by_status[item["status"]] = by_status.get(item["status"], 0) + 1
        if by_points:
            if item["points"] is None:
                unestimated += 1
            value = float(item["points"] or 0)
        else:
            value = 1.0
        if custom_done:
            is_done = item["status"].casefold() in custom_done
        else:
            is_done = item["category"] == "done"
        if is_done:
            done += value
        elif item["category"] == "indeterminate" or (custom_done and item["category"] == "done"):
            in_progress += value
        else:
            todo += value
    return {
        "unit": "points" if by_points else "issues",
        "total": _num(done + in_progress + todo),
        "done": _num(done),
        "inProgress": _num(in_progress),
        "todo": _num(todo),
        "issues": count,
        "unestimated": unestimated,
        "byStatus": by_status,
    }


def empty_totals(measure: str = "count") -> dict:
    return tally([], measure)


def _num(value: float) -> Any:
    """Whole numbers as ints so JSON shows 12, not 12.0."""
    rounded = round(value, 2)
    return int(rounded) if rounded == int(rounded) else rounded
