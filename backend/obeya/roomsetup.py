"""Load a setup file: Jira settings and the Jira-linked walls of a room, in one step.

    python -m obeya setup <file> [--dry-run]

The file says which teams, boards and queries go on the walls (see
backend/setup.example.json). This command turns it into Jira settings and walls,
saves both to the database, runs a sync and prints one line per link, the way
"python -m obeya verify" does. With --dry-run it asks Jira about every link and
writes nothing.

It is a one-time load, not configuration: the server never reads the file, and
everything it creates can be changed in the app afterwards. Running it again
with a changed file updates the walls it created and leaves the others alone.
It builds Jira links only. Statements, risks, problems and actions are for the
team to write.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Optional

from . import verify
from .flow import clean_blocked_rule
from .jira_client import JiraError, JiraUnavailable
from .sources import FIELD_ID_RE, KEY_RE
from .sync import collect_links

VERSION = 1
PREFIX = "setup-"     # ids of the walls and panels this command owns
TOP = {"version", "settings", "replaceRoom", "roomName", "doneStatuses", "teams", "portfolio", "dependencies", "counts"}
JIRA_SETTINGS = {"piField", "storyPointsField", "boardId", "showSummaries", "showAssignees", "blocked", "notCounted"}
TEAM = {"name", "boardId", "scope", "measure", "estimateField", "estimateUnit", "boardQuery"}
PORTFOLIO = {"name", "boardId", "boardQuery", "hiddenColumns", "items", "measure", "estimateField", "estimateUnit"}
DEPENDENCIES = {"jql", "linkTypes"}
COUNT = {"name", "jql", "target"}


class SetupError(Exception):
    """The file cannot be used as it is. Nothing was written."""


# ---------- reading the file ----------

def _unknown(where: str, given: dict, allowed: set[str]) -> None:
    extra = sorted(set(given) - allowed)
    if extra:
        raise SetupError(f"{where}: unknown key{'' if len(extra) == 1 else 's'} {', '.join(extra)}. "
                         f"Allowed: {', '.join(sorted(allowed))}.")


def _obj(where: str, value: Any) -> dict:
    if not isinstance(value, dict):
        raise SetupError(f"{where} must be an object.")
    return value


def _text(where: str, value: Any, required: bool = True) -> str:
    if value is None and not required:
        return ""
    if not isinstance(value, str) or (required and not value.strip()):
        raise SetupError(f"{where} must be {'a non-empty' if required else 'a'} string.")
    return value.strip()


def _names(where: str, value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(v, str) and v.strip() for v in value):
        raise SetupError(f"{where} must be a list of names.")
    return [v.strip() for v in value]


def _board(where: str, value: Any, required: bool = True) -> Optional[int]:
    if value is None and not required:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise SetupError(f"{where} must be a board id (a whole number above zero).")
    return value


def _estimate(where: str, raw: dict) -> dict:
    """measure, and with points optionally the team's own estimate field and its unit."""
    measure = raw.get("measure", "count")
    if measure not in ("count", "points"):
        raise SetupError(f"{where}.measure must be \"count\" or \"points\".")
    out: dict[str, Any] = {"measure": measure}
    field = _text(f"{where}.estimateField", raw.get("estimateField"), required=False)
    unit = _text(f"{where}.estimateUnit", raw.get("estimateUnit"), required=False)
    if field:
        if measure != "points":
            raise SetupError(f"{where}.estimateField only applies with \"measure\": \"points\".")
        if not FIELD_ID_RE.fullmatch(field):
            raise SetupError(f"{where}.estimateField must be a Jira field id such as customfield_10106.")
        out["estimateField"] = field
        if unit:
            out["estimateUnit"] = unit[:12]
    elif unit:
        raise SetupError(f"{where}.estimateUnit needs an estimateField.")
    return out


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "x"


def read_plan(raw: Any) -> dict:
    """Check a parsed setup file and return it with defaults filled in. Raises SetupError."""
    raw = _obj("The setup file", raw)
    _unknown("The setup file", raw, TOP)
    if raw.get("version") != VERSION:
        raise SetupError(f"\"version\" must be {VERSION}.")
    plan: dict[str, Any] = {"version": VERSION, "replaceRoom": raw.get("replaceRoom", False),
                            "roomName": _text("roomName", raw.get("roomName"), required=False),
                            "doneStatuses": _names("doneStatuses", raw.get("doneStatuses")),
                            "settings": None, "teams": [], "portfolio": None, "dependencies": None, "counts": []}
    if not isinstance(plan["replaceRoom"], bool):
        raise SetupError("\"replaceRoom\" must be true or false.")

    if raw.get("settings") is not None:
        settings = _obj("settings", raw["settings"])
        _unknown("settings", settings, {"jira", "pis"})
        jira = _obj("settings.jira", settings.get("jira", {}))
        _unknown("settings.jira", jira, JIRA_SETTINGS)
        if "pis" in settings and not isinstance(settings["pis"], list):
            raise SetupError("settings.pis must be a list of {name, start, end}.")
        plan["settings"] = {"jira": jira, **({"pis": settings["pis"]} if "pis" in settings else {})}

    teams = raw.get("teams", [])
    if not isinstance(teams, list):
        raise SetupError("\"teams\" must be a list.")
    seen: set[str] = set()
    for n, team in enumerate(teams):
        where = f"teams[{n}]"
        team = _obj(where, team)
        _unknown(where, team, TEAM)
        name = _text(f"{where}.name", team.get("name"))
        if slug(name) in seen:
            raise SetupError(f"{where}: there is already a team called \"{name}\".")
        seen.add(slug(name))
        plan["teams"].append({"name": name, "boardId": _board(f"{where}.boardId", team.get("boardId")),
                              "scope": _text(f"{where}.scope", team.get("scope")),
                              "boardQuery": _text(f"{where}.boardQuery", team.get("boardQuery"), required=False),
                              **_estimate(where, team)})

    if raw.get("portfolio") is not None:
        portfolio = _obj("portfolio", raw["portfolio"])
        _unknown("portfolio", portfolio, PORTFOLIO)
        items = _names("portfolio.items", portfolio.get("items"))
        keys = []
        for item in items:
            if not KEY_RE.fullmatch(item.upper()):
                raise SetupError(f"portfolio.items: \"{item}\" is not a Jira key such as PLAT-12.")
            if item.upper() not in keys:
                keys.append(item.upper())
        plan["portfolio"] = {"name": _text("portfolio.name", portfolio.get("name"), required=False) or "Portfolio",
                             "boardId": _board("portfolio.boardId", portfolio.get("boardId"), required=False),
                             "boardQuery": _text("portfolio.boardQuery", portfolio.get("boardQuery"), required=False),
                             "hiddenColumns": _names("portfolio.hiddenColumns", portfolio.get("hiddenColumns")),
                             "items": keys, **_estimate("portfolio", portfolio)}
        if plan["portfolio"]["boardId"] is None and not keys:
            raise SetupError("\"portfolio\" needs a boardId, items, or both.")

    if raw.get("dependencies") is not None:
        deps = _obj("dependencies", raw["dependencies"])
        _unknown("dependencies", deps, DEPENDENCIES)
        plan["dependencies"] = {"jql": _text("dependencies.jql", deps.get("jql")),
                                "linkTypes": _names("dependencies.linkTypes", deps.get("linkTypes"))}

    counts = raw.get("counts", [])
    if not isinstance(counts, list):
        raise SetupError("\"counts\" must be a list.")
    names: set[str] = set()
    for n, count in enumerate(counts):
        where = f"counts[{n}]"
        count = _obj(where, count)
        _unknown(where, count, COUNT)
        name = _text(f"{where}.name", count.get("name"))
        if slug(name) in names:
            raise SetupError(f"{where}: there is already a count called \"{name}\".")
        names.add(slug(name))
        target = count.get("target", "")
        if target != "" and (isinstance(target, bool) or not isinstance(target, (int, float))):
            raise SetupError(f"{where}.target must be a number.")
        plan["counts"].append({"name": name, "jql": _text(f"{where}.jql", count.get("jql")), "target": target})

    if not (plan["teams"] or plan["portfolio"] or plan["dependencies"] or plan["counts"] or plan["settings"]):
        raise SetupError("The setup file names no settings, teams, portfolio, dependencies or counts.")
    return plan


def load(path: str) -> dict:
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except OSError as err:
        raise SetupError(f"Could not read {path}: {err.strerror or err}")
    except ValueError as err:
        raise SetupError(f"{path} is not valid JSON: {err}")
    return read_plan(raw)


# ---------- settings ----------

def merged_settings(current: dict, plan: dict) -> tuple[dict, dict]:
    """(the stored settings, the settings after the load), both in their clean form. Only
    the keys the file gives change, so a PI calendar or a board chosen in the app
    survives a file that does not mention them."""
    from .server import ApiError, clean_settings   # server imports the sync; keep this import local
    try:
        before = clean_settings(current)
        given = plan["settings"]
        if not given:
            return before, before
        return before, clean_settings({"jira": {**before["jira"], **given["jira"]},
                                       "pis": given["pis"] if "pis" in given else before["pis"]})
    except ApiError as err:
        raise SetupError(f"settings: {err}")


def changed_settings(before: dict, after: dict) -> list[str]:
    keys = [k for k in sorted(after["jira"]) if after["jira"][k] != before["jira"].get(k)]
    return keys + (["pis"] if after["pis"] != before["pis"] else [])


# ---------- building walls ----------

def _options(plan: dict, part: dict) -> dict:
    out = {"measure": part["measure"], "includeSubtasks": False, "doneStatuses": list(plan["doneStatuses"])}
    for key in ("estimateField", "estimateUnit"):
        if part.get(key):
            out[key] = part[key]
    return out


def _metric(plan: dict, kind: str, board: Optional[int] = None, jql: str = "", part: Optional[dict] = None) -> dict:
    metric: dict[str, Any] = {"kind": kind, "boardId": board, "jql": jql, "windowDays": 30, "stat": "median",
                              "measure": "count", "doneStatuses": list(plan["doneStatuses"]),
                              "unplanned": {"rule": "added_after_start"}}
    if part and kind in ("scope_done", "wip", "unplanned"):
        metric["measure"] = part["measure"]
        if part.get("estimateField"):
            metric["estimateField"] = part["estimateField"]
    return metric


def _kpi(panel_id: str, name: str, unit: str, direction: str, metric: dict, target: Any = "") -> dict:
    return {"id": f"{panel_id}-{metric['kind']}" if metric["kind"] != "count" else f"{panel_id}-{slug(name)}",
            "name": name, "unit": unit, "target": target, "actual": "", "dir": direction, "history": [], "metric": metric}


def _kpi_panel(panel_id: str, title: str, span: int, items: list[dict]) -> dict:
    return {"id": panel_id, "type": "kpi", "title": title, "span": span, "data": {"items": items}}


def _board_panel(panel_id: str, title: str, board: int, query: str, hidden: list[str]) -> dict:
    return {"id": panel_id, "type": "kanban", "title": title, "span": 3,
            "data": {"columns": [{"id": f"{panel_id}-c1", "name": "To do", "wip": 0}], "cards": [],
                     "jira": {"boardId": board, "jql": query, "sprint": "active", "hiddenColumns": list(hidden),
                              "maxCards": 6, "doneDays": 14, "staleDays": 7}}}


def _display() -> dict:
    return {"color": "status", "valueFormat": "both", "showInProgress": True, "pace": {"kind": "none"}}


def _unit(part: dict) -> str:
    if part["measure"] != "points":
        return "items"
    return part.get("estimateUnit", "") if part.get("estimateField") else "pts"


def team_wall(plan: dict, team: dict, scrum: bool, replay_blocked: bool) -> dict:
    wid = f"{PREFIX}team-{slug(team['name'])}"
    board = team["boardId"]
    now_id, flow_id = f"{wid}-now", f"{wid}-flow"
    now = []
    if scrum:
        now.append(_kpi(now_id, "Scope done", "%", "up", _metric(plan, "scope_done", board, part=team)))
    now.append(_kpi(now_id, "Work in progress", _unit(team), "down", _metric(plan, "wip", board, part=team)))
    now.append(_kpi(now_id, "Blocked items", "", "down", _metric(plan, "blocked_now", board)))
    if scrum:
        now.append(_kpi(now_id, "Unplanned work", "%", "down", _metric(plan, "unplanned", board, part=team)))
    flow_items = [_kpi(flow_id, "Cycle time", "days", "down", _metric(plan, "cycle_time", board)),
                  _kpi(flow_id, "Throughput", "/ week", "up", _metric(plan, "throughput", board))]
    if replay_blocked:
        flow_items.append(_kpi(flow_id, "Blocked days", "days", "down", _metric(plan, "blocked_days", board)))
    # A scrum team's sprint figures sit beside its burn-up; a kanban team's two rows of figures share one.
    panels = [_kpi_panel(now_id, "Sprint health" if scrum else "Right now", 2 if scrum else 1, now)]
    if scrum:
        panels.append({"id": f"{wid}-burnup", "type": "burnup", "title": "Sprint burn-up", "span": 1,
                       "data": {"source": {"kind": "jql", "jql": f"({team['scope']}) AND sprint in openSprints()",
                                           "descend": False, **_options(plan, team)},
                                "period": {"kind": "sprint"}}})
    panels.append(_kpi_panel(flow_id, "Flow, last 30 days", 3 if scrum else 2, flow_items))
    panels.append(_board_panel(f"{wid}-board", "Board", board, team["boardQuery"], []))
    return {"id": wid, "name": team["name"], "subtitle": "Sprint flow and delivery" if scrum else "Flow and delivery",
            "panels": panels}


def portfolio_wall(plan: dict) -> dict:
    part = plan["portfolio"]
    wid = f"{PREFIX}portfolio"
    panels = []
    if part["items"]:
        bars = [{"id": f"{wid}-bar-{key.lower()}", "label": "", "owner": "", "note": "",
                 "source": {"kind": "issue", "key": key, **_options(plan, part)}, **_display()} for key in part["items"]]
        panels.append({"id": f"{wid}-bars", "type": "progress", "title": "Initiatives and epics", "span": 3,
                       "data": {"items": bars, "auto": None, "autoDisplay": _display(), "sort": "manual",
                                "showKeys": True, "showTrend": True, "staleDays": 14}})
    if part["boardId"] is not None:
        panels.append(_board_panel(f"{wid}-board", "Portfolio board", part["boardId"], part["boardQuery"],
                                   part["hiddenColumns"]))
    return {"id": wid, "name": part["name"], "subtitle": "Progress of the work leadership follows", "panels": panels}


def data_wall(plan: dict) -> dict:
    wid = f"{PREFIX}dependencies"
    panels = []
    if plan["dependencies"]:
        panels.append({"id": f"{wid}-deps", "type": "dependencies", "title": "Dependencies", "span": 3,
                       "data": {"source": {"jql": plan["dependencies"]["jql"],
                                           "linkTypes": list(plan["dependencies"]["linkTypes"]),
                                           "showDone": False, "limit": 12}}})
    if plan["counts"]:
        cid = f"{wid}-counts"
        items = [_kpi(cid, c["name"], "", "down", _metric(plan, "count", jql=c["jql"]), c["target"])
                 for c in plan["counts"]]
        panels.append(_kpi_panel(cid, "Counts", 3, items))
    name = "Dependencies and counts" if plan["dependencies"] and plan["counts"] else \
        ("Dependencies" if plan["dependencies"] else "Counts")
    return {"id": wid, "name": name, "subtitle": "What work waits on, and what needs tidying", "panels": panels}


def build_walls(plan: dict, board_types: dict[int, str], settings: dict) -> list[dict]:
    """The walls a plan describes. board_types maps each team board to "scrum" or "kanban"."""
    rule = clean_blocked_rule((settings.get("jira") or {}).get("blocked"))
    replay_blocked = bool(rule["flagged"] or rule["statuses"])
    walls = [team_wall(plan, team, board_types.get(team["boardId"]) == "scrum", replay_blocked) for team in plan["teams"]]
    if plan["portfolio"]:
        walls.append(portfolio_wall(plan))
    if plan["dependencies"] or plan["counts"]:
        walls.append(data_wall(plan))
    return walls


def merge_room(existing: Optional[dict], walls: list[dict], plan: dict) -> dict:
    """The room after the load. Walls this command created before are replaced by the
    new ones, in their old places where the ids match; other walls are kept unless the
    file asks for the whole room to be replaced."""
    room = dict(existing) if isinstance(existing, dict) else {
        "v": 2, "roomName": "Obeya Room", "theme": "auto", "tvTheme": "dark", "accent": "cobalt",
        "density": "comfortable", "rotate": 0, "example": False, "walls": []}
    if plan["roomName"]:
        room["roomName"] = plan["roomName"]
    old = [w for w in room.get("walls") or [] if isinstance(w, dict)]
    if plan["replaceRoom"]:
        old = [w for w in old if str(w.get("id") or "").startswith(PREFIX)]
        room["example"] = False
    fresh = {w["id"]: w for w in walls}
    placed: set[str] = set()
    merged = []
    for wall in old:
        wid = str(wall.get("id") or "")
        if not wid.startswith(PREFIX):
            merged.append(wall)
        elif wid in fresh:
            merged.append(fresh[wid])
            placed.add(wid)
    merged.extend(w for w in walls if w["id"] not in placed)
    room["walls"] = merged
    return room


# ---------- running it ----------

def _board_types(client, plan: dict) -> dict[int, str]:
    types: dict[int, str] = {}
    boards = [(f"teams: \"{t['name']}\"", t["boardId"]) for t in plan["teams"]]
    if plan["portfolio"] and plan["portfolio"]["boardId"] is not None:
        boards.append(("portfolio", plan["portfolio"]["boardId"]))
    for where, board in boards:
        try:
            types[board] = str(client.board_config(board).get("type") or "").lower()
        except JiraUnavailable:
            raise
        except JiraError as err:
            raise SetupError(f"{where}: board {board} cannot be read in Jira ({err}). "
                             "Check the id, and that the Jira account can view the board.")
    return types


def _notes(plan: dict, settings: dict, board_types: dict[int, str], room: dict) -> list[str]:
    notes = []
    jira = settings.get("jira") or {}
    scrum = [t["name"] for t in plan["teams"] if board_types.get(t["boardId"]) == "scrum"]
    if scrum and not jira.get("boardId"):
        notes.append("No board is chosen for the current sprint (settings.jira.boardId), so sprint burn-up charts "
                     "have no dates to draw against yet.")
    rule = clean_blocked_rule(jira.get("blocked"))
    if plan["teams"] and not (rule["flagged"] or rule["statuses"]):
        notes.append("\"Blocked days\" was left off the team walls: it needs the Jira flag or a blocked status "
                     "under \"Blocked means\".")
    if plan["portfolio"] and not plan["portfolio"]["items"]:
        notes.append("The portfolio wall has no bars yet: portfolio.items lists no initiative or epic keys.")
    kept = [str(w.get("name") or w.get("id")) for w in room["walls"] if not str(w.get("id") or "").startswith(PREFIX)]
    if kept:
        notes.append(f"Walls this command did not create were kept: {', '.join(kept)}. "
                     "Their links are checked below as well.")
    return notes


def _dry_results(engine, room: dict) -> dict:
    """Compute every link of a room without storing anything, in the shape results_for returns."""
    links = collect_links(room)
    computed = {sid: engine.compute(spec) for sid, spec in links.specs.items()}
    pick = lambda owners: {owner: computed[sid] for owner, sid in owners.items()}   # noqa: E731
    return {"progress": pick(links.items), "auto": pick(links.autos), "boards": pick(links.boards),
            "metrics": pick(links.metrics), "burnups": pick(links.burnups), "deps": pick(links.deps)}


def run(db, syncer, path: str, dry_run: bool = False) -> tuple[int, str]:
    """Load a setup file. Returns (exit code, text): 0 when every link works, 1 when a
    link failed, 2 when the file could not be used and nothing was written."""
    out: list[str] = []
    try:
        plan = load(path)
        client = syncer.client()
        if client is None:
            raise SetupError("Jira is not connected. Set JIRA_BASE_URL and JIRA_TOKEN, then run this again.")
        current, settings = merged_settings(db.get_settings(), plan)
        board_types = _board_types(client, plan)
        walls = build_walls(plan, board_types, settings)
        row = db.get_room()
        existing = row["doc"] if row else None
        room = merge_room(existing, walls, plan) if walls or plan["replaceRoom"] or plan["roomName"] else existing
    except SetupError as err:
        return 2, f"Nothing was changed. {err}"
    except JiraUnavailable as err:
        return 2, f"Nothing was changed. {err}"

    mode = "Dry run: nothing is written." if dry_run else "Loading the setup file."
    out.append(f"{mode} {len(plan['teams'])} team wall{'' if len(plan['teams']) == 1 else 's'}"
               + (", a portfolio wall" if plan["portfolio"] else "")
               + (", a dependencies and counts wall" if plan["dependencies"] or plan["counts"] else "") + ".")

    changed = changed_settings(current, settings)
    verb = "would change" if dry_run else "saved"
    out.append("Settings: " + (f"{verb} ({', '.join(changed)})." if changed else
                               ("not in the file, left as they are." if not plan["settings"] else "already as the file says.")))
    room_changed = room is not None and room != existing
    if room is None:
        out.append("Room: there is none, and the file describes no walls.")
    elif room_changed:
        names = ", ".join(w["name"] for w in walls) or "none"
        out.append(f"Room: {'would save' if dry_run else 'saved'} with these walls built: {names}."
                   + (" Every other wall was dropped (replaceRoom)." if plan["replaceRoom"] else ""))
    else:
        out.append("Room: already as the file says.")
    for note in _notes(plan, settings, board_types, room or {"walls": []}):
        out.append(f"Note: {note}")
    out.append("")

    if dry_run:
        if room is None:
            return 0, "\n".join(out).rstrip()
        try:
            lines = verify.report(room, _dry_results(syncer.engine(settings), room))
        except JiraUnavailable as err:
            return 1, "\n".join(out) + f"Jira could not be reached to try the links: {err}"
        return (1 if verify.failed(lines) else 0), "\n".join(out) + "\n" + verify.format_report(lines)

    if changed:
        db.save_settings(settings)
    if room_changed:
        saved = db.save_room(room, row["version"] if row else 0)
        if saved is None:
            return 2, "\n".join(out) + "The room was saved by someone else at the same moment. Run the command again."
    if room is None:
        return 0, "\n".join(out).rstrip()
    code, text = verify.run(db, syncer)
    return code, "\n".join(out) + "\n" + text
