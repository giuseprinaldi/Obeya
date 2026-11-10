"""PI calendar, sprint periods and JQL variables. Pure functions, no I/O."""
from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any, Optional


class TemplateError(ValueError):
    """A JQL template cannot be resolved; the message is shown to the user."""


def parse_date(value: Any) -> Optional[date]:
    """Accept YYYY-MM-DD or a full ISO timestamp (as Jira returns for sprints)."""
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if not isinstance(value, str) or len(value) < 10:
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def clean_calendar(pis: Any) -> list[dict]:
    """Keep well-formed PIs only, sorted by start date."""
    out = []
    for item in pis if isinstance(pis, list) else []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        start, end = parse_date(item.get("start")), parse_date(item.get("end"))
        if not name or not start or not end or end < start:
            continue
        out.append({"name": name[:80], "start": start.isoformat(), "end": end.isoformat()})
    out.sort(key=lambda p: (p["start"], p["end"]))
    return out


def pick_pis(pis: list[dict], today: date) -> tuple[Optional[dict], Optional[dict], Optional[dict]]:
    """Return (previous, current, next) for a cleaned calendar.

    The current PI is the one containing today. Between PIs, or after the last
    one, the most recently started PI stays current until the next one starts,
    so screens do not go blank over a gap.
    """
    t = today.isoformat()
    started = [i for i, p in enumerate(pis) if p["start"] <= t]
    if not started:
        return None, None, (pis[0] if pis else None)
    containing = [i for i in started if pis[i]["end"] >= t]
    cur = containing[-1] if containing else started[-1]
    prev = pis[cur - 1] if cur > 0 else None
    nxt = pis[cur + 1] if cur + 1 < len(pis) else None
    return prev, pis[cur], nxt


def sprint_period(sprint: Any) -> Optional[dict]:
    """Convert a Jira agile sprint object to a period."""
    if not isinstance(sprint, dict):
        return None
    start, end = parse_date(sprint.get("startDate")), parse_date(sprint.get("endDate"))
    name = str(sprint.get("name") or "").strip()
    if not name or not start or not end:
        return None
    return {"name": name, "start": start.isoformat(), "end": end.isoformat()}


def field_ref(field_id: str) -> str:
    """How to name a field in JQL: cf[10500] for custom fields, else the id itself."""
    m = re.fullmatch(r"customfield_(\d+)", field_id or "")
    if m:
        return f"cf[{m.group(1)}]"
    return '"' + (field_id or "").replace("\\", "\\\\").replace('"', '\\"') + '"'


_VAR = re.compile(r"\{(PI|NEXT_PI|PREV_PI|PI_FIELD)\}")

_MISSING = {
    "PI": "This query uses {PI}, but the PI calendar has no current PI. Add one in Jira settings.",
    "NEXT_PI": "This query uses {NEXT_PI}, but the PI calendar has no PI after the current one.",
    "PREV_PI": "This query uses {PREV_PI}, but the PI calendar has no PI before the current one.",
    "PI_FIELD": "This query uses {PI_FIELD}, but no PI field is chosen. Pick it in Jira settings.",
}


def resolve_jql(jql: str, pi_field: str, pis: list[dict], today: date) -> str:
    """Replace {PI}, {NEXT_PI}, {PREV_PI} and {PI_FIELD} in a JQL template.

    PI names are escaped for use inside a double-quoted JQL string, which is
    how the presets use them: {PI_FIELD} = "{PI}".
    """
    prev, cur, nxt = pick_pis(pis, today)
    values = {
        "PI": cur["name"] if cur else None,
        "NEXT_PI": nxt["name"] if nxt else None,
        "PREV_PI": prev["name"] if prev else None,
    }

    def sub(match: "re.Match[str]") -> str:
        name = match.group(1)
        if name == "PI_FIELD":
            if not pi_field:
                raise TemplateError(_MISSING[name])
            return field_ref(pi_field)
        value = values[name]
        if value is None:
            raise TemplateError(_MISSING[name])
        return value.replace("\\", "\\\\").replace('"', '\\"')

    return _VAR.sub(sub, jql)
