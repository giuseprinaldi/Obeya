"""Dependencies between issues, read from Jira's issue links.

Pure functions over Jira issue JSON, no I/O. Jira describes a link from each
end in words ("is blocked by" / "blocks", "depends on" / "is depended on by"),
and which end is "inward" differs between link types, so the direction is
taken from those words rather than from the inward/outward slot.
"""
from __future__ import annotations

import re
from typing import Any, Optional

MAX_DEPENDENCIES = 200   # sent to screens; the true total is always reported

# "A <phrase> B" means A cannot finish until B has.
_WAITS = re.compile(r"blocked by|\bdepends? (up)?on\b|\bdependent on\b|\brequires\b|\bneeds\b|preceded by|"
                    r"\bfollows\b|done after|\bwaits? (on|for)\b|\bprerequisite is\b")
# "A <phrase> B" means B cannot finish until A has.
_PROVIDES = re.compile(r"\bblocks\b|depended (up)?on by|required by|needed by|\bprecedes\b|followed by|"
                       r"done before|dependency (of|for)|prerequisite (of|for)")


def link_direction(phrase: Any) -> Optional[str]:
    """"waits" when the phrase says this issue waits on the other one, "provides"
    when the other one waits on this, None when the link is not a dependency
    ("relates to", "duplicates", "clones")."""
    text = str(phrase or "").casefold()
    if _WAITS.search(text):
        return "waits"
    if _PROVIDES.search(text):
        return "provides"
    return None


def _issue(raw: dict, base_url: str, show_summaries: bool) -> dict:
    fields = raw.get("fields") or {}
    status = fields.get("status") or {}
    key = str(raw.get("key") or "")
    return {
        "key": key,
        "title": str(fields.get("summary") or key) if show_summaries else key,
        "url": f"{base_url}/browse/{key}",
        "status": str(status.get("name") or ""),
        "category": str((status.get("statusCategory") or {}).get("key") or ""),   # new, indeterminate or done
        "project": key.rsplit("-", 1)[0] if "-" in key else "",
    }


def dependencies(issues: list[dict], base_url: str, link_types: Optional[list[str]] = None,
                 show_summaries: bool = True) -> list[dict]:
    """Every dependency that touches the given issues, once each.

    Each is {"waiting": issue, "on": issue, "type": link type name}: `waiting`
    cannot finish until `on` has. link_types, when given, names the link types
    to read; without it every link whose wording reads as a dependency counts.
    A named type whose wording says nothing follows Jira's own "Blocks"
    convention: the inward issue is the one being waited on.
    """
    wanted = {str(name).strip().casefold() for name in link_types or [] if str(name).strip()}
    full = {str(r.get("key") or ""): r for r in issues}
    out: dict[tuple[str, str, str], dict] = {}
    for raw in issues:
        for link in (raw.get("fields") or {}).get("issuelinks") or []:
            if not isinstance(link, dict):
                continue
            kind = link.get("type") if isinstance(link.get("type"), dict) else {}
            name = str(kind.get("name") or "")
            if wanted and name.casefold() not in wanted:
                continue
            for slot, phrase, fallback in (("inwardIssue", kind.get("inward"), "waits"),
                                           ("outwardIssue", kind.get("outward"), "provides")):
                other = link.get(slot)
                if not isinstance(other, dict) or not other.get("key"):
                    continue
                direction = link_direction(phrase) or (fallback if wanted else None)
                if direction is None:
                    continue
                # The linked issue arrives with a few fields only; use the full one when it is in scope too.
                other = full.get(str(other["key"]), other)
                waiting, on = (raw, other) if direction == "waits" else (other, raw)
                key = (str(waiting.get("key")), str(on.get("key")), name.casefold())
                if key[0] == key[1] or key in out:
                    continue
                out[key] = {"waiting": _issue(waiting, base_url, show_summaries),
                            "on": _issue(on, base_url, show_summaries), "type": name}
    return sorted(out.values(), key=_order)


def _order(dep: dict) -> tuple:
    """What needs attention first: work already under way that waits on something unfinished,
    then other open dependencies, then the ones that are settled; across projects before within one."""
    settled = dep["on"]["category"] == "done" or dep["waiting"]["category"] == "done"
    under_way = dep["waiting"]["category"] == "indeterminate"
    rank = 2 if settled else 0 if under_way else 1
    return (rank, dep["waiting"]["project"] == dep["on"]["project"], dep["waiting"]["key"], dep["on"]["key"])
