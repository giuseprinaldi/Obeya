"""Check a real Jira against everything Obeya relies on.

Each check is one question with a plain answer. They run in order; if Jira
cannot be reached or rejects the token, the rest are skipped rather than
reported as separate failures. Read-only, like everything else.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Optional

from .jira_client import JiraClient, JiraError, JiraUnavailable
from .periods import clean_calendar, field_ref, pick_pis
from .sources import text_values

PASS, WARN, FAIL, SKIP = "pass", "warn", "fail", "skip"


class _Report:
    def __init__(self) -> None:
        self.checks: list[dict] = []
        self.stopped = False   # Jira is unusable; skip what is left

    def add(self, check_id: str, label: str, status: str, detail: str, fix: str = "") -> None:
        self.checks.append({"id": check_id, "label": label, "status": status, "detail": detail, "fix": fix})

    def run(self, check_id: str, label: str, fn: Callable[[], tuple], needs_jira: bool = True) -> None:
        """fn returns (status, detail) or (status, detail, fix)."""
        if needs_jira and self.stopped:
            self.add(check_id, label, SKIP, "Not checked, because Jira could not be used.")
            return
        try:
            result = fn()
        except JiraUnavailable as err:
            self.stopped = True
            self.add(check_id, label, FAIL, str(err), "Fix the connection, then run the check again.")
            return
        except JiraError as err:
            self.add(check_id, label, FAIL, f"Jira refused this request: {err}")
            return
        except Exception as err:   # a shape we did not expect is itself a finding
            self.add(check_id, label, FAIL, f"Unexpected answer from Jira: {err}")
            return
        self.add(check_id, label, *result)

    def result(self) -> dict:
        return {"ok": not any(c["status"] == FAIL for c in self.checks),
                "ranAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "checks": self.checks}


def _readable_pointer(value: Any) -> bool:
    """Can the hierarchy walk tell which parent this value names?"""
    if isinstance(value, (str, int)) and str(value).strip():
        return True
    if isinstance(value, dict):
        data = value.get("data") if isinstance(value.get("data"), dict) else {}
        return any(v not in (None, "") for v in (value.get("key"), value.get("id"), data.get("key"), data.get("id")))
    return False


def run_diagnostics(client: Optional[JiraClient], settings: dict, configured: bool,
                    today: Optional[date] = None) -> dict:
    report = _Report()
    today = today or date.today()
    jira = settings.get("jira") or {}
    pis = clean_calendar(settings.get("pis"))

    # ---- connection ----

    if not configured or client is None:
        report.add("configured", "Jira address and token", FAIL,
                   "The server has no Jira address or token.",
                   "Set JIRA_BASE_URL and JIRA_TOKEN in the server's environment and restart it.")
        report.stopped = True
    else:
        report.add("configured", "Jira address and token", PASS, f"Using {client.base_url}.")

    def reachable() -> tuple:
        info = client.server_info()
        kind = str(info.get("deploymentType") or "Server")
        version = str(info.get("version") or "unknown version")
        if kind.lower() == "cloud":
            return (WARN, f"Jira Cloud {version} answered.",
                    "Obeya has only been tried against Jira Data Center. Cloud should work but is untested.")
        return (PASS, f"Jira {kind} {version} answered.")
    report.run("reachable", "Jira can be reached", reachable)

    def token() -> tuple:
        me = client.myself()
        name = str(me.get("displayName") or me.get("name") or me.get("emailAddress") or "an account")
        return (PASS, f"Signed in as {name}.")
    report.run("token", "Token accepted", token)

    sample: dict[str, Any] = {}

    def visible() -> tuple:
        issues, _ = client.search("order by updated desc", ["summary", "status", "statuscategorychangedate"],
                                  limit=1, changelog=True)
        if not issues:
            return (FAIL, "The account can sign in but sees no issues at all.",
                    "Give the account Browse Projects permission on the projects you want on the walls.")
        sample["issue"] = issues[0]
        return (PASS, f"The account can read issues (most recently updated: {issues[0].get('key')}).")
    report.run("visible", "Issues are visible", visible)

    # ---- fields ----

    found: dict[str, Any] = {}

    def fields() -> tuple:
        found.update(client.discovered_fields())
        known = {str(f.get("id")) for f in client.fields()}
        chosen = str(jira.get("storyPointsField") or "")
        if chosen and chosen not in known:
            return (WARN, f"The points field chosen in Jira settings ({chosen}) does not exist in this Jira.",
                    "Pick the story points field again under Fields in Jira settings, or set it to detect automatically.")
        missing = []
        if not found.get("epic_link") and not client.is_cloud():
            missing.append("Epic Link")
        if not found.get("story_points") and not chosen:
            missing.append("Story Points")
        if missing:
            return (WARN, "Could not find: " + ", ".join(missing) + ".",
                    "Without Epic Link, epics cannot be measured by their stories. Without Story Points, "
                    "measure by issue count, or pick the points field in Jira settings.")
        points = jira.get("storyPointsField") or (found.get("story_points") or {}).get("id")
        return (PASS, f"Epic Link and Story Points found (points field: {points}).")
    report.run("fields", "Epic Link and Story Points fields", fields)

    def flagged() -> tuple:
        if found.get("flagged"):
            return (PASS, f"Found as {found['flagged']['id']}.")
        return (WARN, "There is no custom field called \"Flagged\".",
                "The flag rule under \"Blocked means\" will never match. Use a status, label or link rule instead.")
    report.run("flagged", "Flagged field", flagged)

    def hierarchy() -> tuple:
        if client.is_cloud():
            return (PASS, "Jira Cloud links children through the parent field.")
        notes, status, fix = [], PASS, ""
        epic = found.get("epic_link")
        if epic:
            issues, _ = client.search(f'"{epic["name"]}" is not EMPTY', [epic["id"]], limit=1)
            if not issues:
                notes.append("no issue has an Epic Link yet")
            elif _readable_pointer((issues[0].get("fields") or {}).get(epic["id"])):
                notes.append("Epic Link values can be read")
            else:
                status, fix = WARN, "Epics will still be measured, with one extra Jira call per epic."
                notes.append("Epic Link values come back in a form that does not name the epic")
        parent = found.get("parent_link")
        if not parent:
            notes.append("there is no Parent Link field, so initiatives above epics cannot be walked")
            status = WARN
            fix = fix or ("Parent Link comes with Advanced Roadmaps. Without it, link bars to epics, "
                          "or use a query for an initiative.")
        else:
            issues, _ = client.search(f'"{parent["name"]}" is not EMPTY', [parent["id"]], limit=1)
            if not issues:
                notes.append("no issue has a Parent Link yet")
            elif _readable_pointer((issues[0].get("fields") or {}).get(parent["id"])):
                notes.append("Parent Link values can be read")
            else:
                status = WARN
                fix = fix or "Initiatives will still be measured, with one extra Jira call per epic."
                notes.append("Parent Link values come back in a form that does not name the parent")
        text = "; ".join(notes)
        return (status, text[:1].upper() + text[1:] + ".", fix)
    report.run("hierarchy", "Epic and initiative links", hierarchy)

    # ---- PI ----

    def pi_field() -> tuple:
        field = str(jira.get("piField") or "")
        if not field:
            return (WARN, "No PI field is chosen.",
                    "Pick it under Fields in Jira settings. Until then, queries that use {PI_FIELD} show an error.")
        if field not in {str(f.get("id")) for f in client.fields()}:
            return (FAIL, f"The PI field chosen in Jira settings ({field}) does not exist in this Jira.",
                    "Pick the PI field again under Fields in Jira settings.")
        ref = field_ref(field)
        issues, _ = client.search(f"{ref} is not EMPTY ORDER BY updated DESC", [field], limit=200)
        values: dict[str, None] = {}
        for issue in issues:
            for text in text_values((issue.get("fields") or {}).get(field)):
                values.setdefault(text)
        if not values:
            return (WARN, f"No issue has a value in {field}.",
                    "Check that this is the field your teams fill in for the PI.")
        first = next(iter(values))
        escaped = first.replace("\\", "\\\\").replace('"', '\\"')
        try:
            matched, _ = client.search(f'{ref} = "{escaped}"', [field], limit=1)
        except JiraUnavailable:
            raise
        except JiraError as err:
            return (FAIL, f"The field does not accept \"=\" in a query: {err}",
                    f"Write PI queries with \"~\" instead, for example: {ref} ~ \"{{PI}}\".")
        if not matched:
            return (WARN, f"A query for {ref} = \"{first}\" found nothing, although issues carry that value.",
                    f"Try \"~\" instead of \"=\" in PI queries: {ref} ~ \"{{PI}}\".")
        _, current, _ = pick_pis(pis, today)
        shown = ", ".join(list(values)[:5])
        if current and current["name"] not in values:
            return (WARN, f"The calendar's current PI is \"{current['name']}\", but Jira uses: {shown}.",
                    "PI names in the calendar must match Jira exactly. Rename the PI in Jira settings.")
        return (PASS, f"Values in Jira: {shown}.")
    report.run("pi_field", "PI field", pi_field)

    def calendar() -> tuple:
        _, current, nxt = pick_pis(pis, today)
        if not pis:
            return (WARN, "The PI calendar is empty.", "Add your PIs under Jira settings so {PI} has a value.")
        if not current:
            return (WARN, f"The first PI in the calendar starts on {pis[0]['start']}.", "")
        if current["end"] < today.isoformat():
            return (WARN, f"The calendar ended on {current['end']}; \"{current['name']}\" is still being used.",
                    "Add the next PI under Jira settings.")
        if not nxt and current["end"] <= (today + timedelta(days=14)).isoformat():
            return (WARN, f"\"{current['name']}\" ends on {current['end']} and nothing follows it.",
                    "Add the next PI under Jira settings so bars roll over on the day.")
        return (PASS, f"Current PI is \"{current['name']}\", until {current['end']}"
                      + (f"; then \"{nxt['name']}\"." if nxt else "."))
    report.run("calendar", "PI calendar", calendar, needs_jira=False)

    # ---- boards and flow ----

    def boards() -> tuple:
        listed = client.boards(limit=50)
        if not listed:
            return (WARN, "The account sees no boards.",
                    "Flow boards and sprint pace need a board the account can view.")
        board_id = jira.get("boardId")
        if not board_id:
            return (WARN, f"{len(listed)} boards are visible, but none is chosen for the current sprint.",
                    "Pick the board under Jira settings to pace bars against the sprint.")
        config = client.board_config(int(board_id))
        columns = (config.get("columnConfig") or {}).get("columns") or []
        name = str(config.get("name") or f"board {board_id}")
        if not columns:
            return (FAIL, f"{name} has no columns in its configuration.", "")
        if str(config.get("type") or "").lower() == "scrum":
            sprint = client.active_sprint(int(board_id))
            if not sprint:
                return (WARN, f"{name} has {len(columns)} columns but no active sprint right now.",
                        "Sprint pace and sprint metrics have nothing to measure until a sprint starts.")
            return (PASS, f"{name}: {len(columns)} columns, active sprint \"{sprint.get('name')}\".")
        return (PASS, f"{name} (kanban): {len(columns)} columns.")
    report.run("boards", "Boards and sprints", boards)

    def statuses() -> tuple:
        categories = client.status_categories()
        if not categories or not any(categories.values()):
            return (FAIL, "Jira returned no status categories.",
                    "Cycle time and the other look-back metrics cannot tell when work started or finished.")
        return (PASS, f"{len(categories)} statuses with their categories.")
    report.run("statuses", "Status categories", statuses)

    def history() -> tuple:
        # A finished issue must have changed status at least once, so it is the honest sample.
        finished, _ = client.search("statusCategory = Done ORDER BY updated DESC", ["status"], limit=1, changelog=True)
        issue = finished[0] if finished else sample.get("issue")
        if not issue:
            return (SKIP, "No issue was available to look at.")
        needs = ("Cycle time, lead time, throughput, blocked days, \"added after the sprint started\" and the "
                 "earlier days of burn-up charts need them.")
        log = issue.get("changelog")
        if not isinstance(log, dict) or not isinstance(log.get("histories"), list):
            return (FAIL, "Searches do not return issue histories.", needs)
        entries = log["histories"]
        got, total = len(entries), int(log.get("total") or len(entries))
        if total > got:
            return (WARN, f"{issue.get('key')} has {total} history entries but Jira returned {got}.",
                    "Long-lived issues may be measured from an incomplete history.")
        moved = any(str(item.get("field") or "").lower() == "status"
                    for entry in entries for item in entry.get("items") or [])
        if finished and not moved:
            return (WARN, f"{issue.get('key')} is finished, but its history shows no status change.",
                    "Look-back metrics will not see when work like this started or finished. " + needs)
        if not finished:
            return (WARN, "No finished issue is visible yet, so there was no history to inspect.",
                    "Run the check again once some work is done.")
        return (PASS, f"Histories are returned in full ({got} entries on {issue.get('key')}, including its status changes).")
    report.run("history", "Issue histories", history)

    def age() -> tuple:
        issue = sample.get("issue")
        if not issue:
            return (SKIP, "No issue was available to look at.")
        if (issue.get("fields") or {}).get("statuscategorychangedate"):
            return (PASS, "Jira reports when each issue last changed status category.")
        return (WARN, "This Jira does not report when an issue last changed status category.",
                "Cards will not show how many days they have been in their column. Nothing else is affected.")
    report.run("age", "Days in status on cards", age)

    return report.result()


def format_text(result: dict) -> str:
    """For the command line."""
    words = {PASS: "PASS", WARN: "WARN", FAIL: "FAIL", SKIP: "SKIP"}
    lines = []
    for check in result["checks"]:
        lines.append(f"[{words[check['status']]}] {check['label']}: {check['detail']}")
        if check["fix"]:
            lines.append(f"       {check['fix']}")
    failed = sum(1 for c in result["checks"] if c["status"] == FAIL)
    warned = sum(1 for c in result["checks"] if c["status"] == WARN)
    lines.append("")
    lines.append("Everything passed." if not failed and not warned
                 else f"{failed} failed, {warned} warning{'' if warned == 1 else 's'}.")
    return "\n".join(lines)
