"""Say, link by link, whether the room shows real data.

    python -m obeya verify

runs a full sync and prints one line for every Jira link in the room: PASS with
the figure it produced, EMPTY when Jira answered but nothing is in scope, or
FAIL with the error. It exits 1 if the sync failed or any link failed, so a
person or a script can tell "done" from "not done" without reading the API.
Read-only towards Jira, like everything else.
"""
from __future__ import annotations

from typing import Any, Optional

from .sync import collect_links

PASS, EMPTY, FAIL = "PASS", "EMPTY", "FAIL"


def _num(value: Any) -> str:
    if isinstance(value, float) and value == int(value):
        value = int(value)
    return str(value)


def _progress(result: dict) -> tuple[str, str]:
    unit = "points" if result.get("unit") == "points" else "issues"
    text = f"{_num(result.get('done', 0))} of {_num(result.get('total', 0))} {unit} done"
    if result.get("unit") == "points" and result.get("unestimated"):
        text += f", {result['unestimated']} of {result.get('issues', 0)} issues unestimated"
    if not result.get("issues"):
        return EMPTY, "no issues in scope"
    return PASS, text


def _auto(result: dict) -> tuple[str, str]:
    bars = result.get("bars") or []
    if not bars:
        return EMPTY, "the query matches nothing, so it adds no bars"
    keys = ", ".join(str(b.get("key") or "?") for b in bars[:5]) + ("…" if len(bars) > 5 else "")
    return PASS, f"{len(bars)} bar{'' if len(bars) == 1 else 's'} ({keys})" + (", more match than the limit" if result.get("truncated") else "")


def _board(result: dict) -> tuple[str, str]:
    columns = result.get("columns") or []
    names = ", ".join(f"{c.get('name')} {c.get('total')}" for c in columns)
    text = f"{result.get('boardName') or 'board'}: {result.get('total', 0)} issues ({names})"
    return (PASS if result.get("total") else EMPTY), text


def _metric(result: dict, shown_unit: str = "") -> tuple[str, str]:
    if result.get("value") is None:
        return EMPTY, f"nothing to measure yet ({result.get('detail') or 'no detail'})"
    # The KPI's own unit is what the wall shows, so it is what the line shows.
    unit = shown_unit or str(result.get("unit") or "")
    return PASS, f"{_num(result['value'])}{' ' + unit if unit else ''} ({result.get('detail') or ''})"


def _deps(result: dict) -> tuple[str, str]:
    scope = result.get("scope", 0)
    if not scope:
        return EMPTY, "the query matches no issues"
    return PASS, f"{result.get('total', 0)} dependencies among {scope} issues"


def _line(where: str, result: Optional[dict], describe) -> dict:
    if result is None:
        return {"status": FAIL, "where": where, "text": "no result: the sync did not compute this link"}
    if not result.get("ok"):
        return {"status": FAIL, "where": where, "text": str(result.get("error") or "Jira could not read this link.")}
    status, text = describe(result)
    return {"status": status, "where": where, "text": text}


def report(room: Any, results: dict) -> list[dict]:
    """One entry per Jira link in the room, in the order the room shows them.
    `results` is what Syncer.results_for returns. Each entry has status, where and text."""
    links = collect_links(room)
    out: list[dict] = []
    for wall in (room or {}).get("walls") or []:
        for panel in wall.get("panels") or []:
            data = panel.get("data") if isinstance(panel.get("data"), dict) else {}
            pid = str(panel.get("id") or "")
            place = f"{wall.get('name') or 'Wall'} / {panel.get('title') or 'Panel'}"
            for item in data.get("items") or []:
                if not isinstance(item, dict):
                    continue
                iid = str(item.get("id") or "")
                name = str(item.get("label") or item.get("name") or "").strip()
                if iid in links.items and panel.get("type") in ("progress", "portfolio"):
                    source = item.get("source") or {}
                    name = name or str(source.get("key") or "query")
                    out.append(_line(f"{place} / {name}", results["progress"].get(iid), _progress))
                if iid in links.metrics and panel.get("type") == "kpi":
                    unit = str(item.get("unit") or "").strip()
                    out.append(_line(f"{place} / {name or 'KPI'}", results["metrics"].get(iid),
                                     lambda r, unit=unit: _metric(r, unit)))
            if pid in links.autos and panel.get("type") == "progress":
                out.append(_line(f"{place} / auto-fill query", results["auto"].get(pid), _auto))
            if pid in links.boards and panel.get("type") == "kanban":
                out.append(_line(place, results["boards"].get(pid), _board))
            if pid in links.burnups and panel.get("type") == "burnup":
                out.append(_line(place, results["burnups"].get(pid), _progress))
            if pid in links.deps and panel.get("type") == "dependencies":
                out.append(_line(place, results["deps"].get(pid), _deps))
    return out


def format_report(lines: list[dict]) -> str:
    out = [f"[{line['status']}] {line['where']}: {line['text']}" for line in lines]
    failed = sum(1 for line in lines if line["status"] == FAIL)
    empty = sum(1 for line in lines if line["status"] == EMPTY)
    out.append("")
    if not lines:
        out.append("The room has no Jira links.")
    elif failed:
        out.append(f"{len(lines)} links, {failed} failed.")
    else:
        out.append(f"{len(lines)} links, none failed.")
    if empty:
        out.append(f"{empty} {'is' if empty == 1 else 'are'} empty: Jira answered, but nothing is in scope. "
                   "Check that each points at the right board, team or query.")
    return "\n".join(out)


def failed(lines: list[dict]) -> bool:
    return any(line["status"] == FAIL for line in lines)


def run(db, syncer) -> tuple[int, str]:
    """Sync, then report. Returns (exit code, text)."""
    if not syncer.cfg.jira_configured:
        return 1, "Jira is not connected. Set JIRA_BASE_URL and JIRA_TOKEN, then run this again."
    row = db.get_room()
    if not row:
        return 1, "There is no room yet. Run \"python -m obeya setup <file>\", or open the app once in a browser."
    outcome = syncer.run(full=True, force=True)
    if not outcome["ok"]:
        return 1, f"The sync stopped: {outcome['error']}"
    lines = report(row["doc"], syncer.results_for(row["doc"]))
    head = f"Synced in {outcome['durationMs'] / 1000:.1f} s.\n\n"
    return (1 if failed(lines) else 0), head + format_report(lines)
