"""Sample Jira data: two initiatives, their epics, stories, bugs and a few sub-tasks,
each with a plausible history (status changes, flags, sprint moves)."""
from __future__ import annotations

import random
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Optional

EPIC_LINK = "customfield_10101"
PARENT_LINK = "customfield_10102"
SPRINT = "customfield_10104"
STORY_POINTS = "customfield_10106"
FLAGGED = "customfield_10107"
PI_FIELD = "customfield_10500"

FIELDS = [
    {"id": "summary", "name": "Summary", "custom": False, "schema": {"type": "string", "system": "summary"}},
    {"id": "status", "name": "Status", "custom": False, "schema": {"type": "status", "system": "status"}},
    {"id": "issuetype", "name": "Issue Type", "custom": False, "schema": {"type": "issuetype", "system": "issuetype"}},
    {"id": "parent", "name": "Parent", "custom": False},
    {"id": "assignee", "name": "Assignee", "custom": False, "schema": {"type": "user", "system": "assignee"}},
    {"id": "labels", "name": "Labels", "custom": False, "schema": {"type": "array", "system": "labels"}},
    {"id": "issuelinks", "name": "Linked Issues", "custom": False, "schema": {"type": "array", "system": "issuelinks"}},
    {"id": "created", "name": "Created", "custom": False, "schema": {"type": "datetime", "system": "created"}},
    {"id": "updated", "name": "Updated", "custom": False, "schema": {"type": "datetime", "system": "updated"}},
    {"id": "resolutiondate", "name": "Resolved", "custom": False, "schema": {"type": "datetime", "system": "resolutiondate"}},
    {"id": "statuscategorychangedate", "name": "Status Category Changed", "custom": False,
     "schema": {"type": "datetime", "system": "statuscategorychangedate"}},
    {"id": EPIC_LINK, "name": "Epic Link", "custom": True,
     "schema": {"type": "any", "custom": "com.pyxis.greenhopper.jira:gh-epic-link", "customId": 10101}},
    {"id": PARENT_LINK, "name": "Parent Link", "custom": True,
     "schema": {"type": "any", "custom": "com.atlassian.jpo:jpo-custom-field-parent", "customId": 10102}},
    {"id": SPRINT, "name": "Sprint", "custom": True,
     "schema": {"type": "array", "custom": "com.pyxis.greenhopper.jira:gh-sprint", "customId": 10104}},
    {"id": STORY_POINTS, "name": "Story Points", "custom": True,
     "schema": {"type": "number", "custom": "com.atlassian.jira.plugin.system.customfieldtypes:float", "customId": 10106}},
    {"id": FLAGGED, "name": "Flagged", "custom": True,
     "schema": {"type": "array", "custom": "com.atlassian.jira.plugin.system.customfieldtypes:multicheckboxes", "customId": 10107}},
    {"id": PI_FIELD, "name": "Program Increment", "custom": True,
     "schema": {"type": "option", "custom": "com.atlassian.jira.plugin.system.customfieldtypes:select", "customId": 10500}},
    {"id": "customfield_10501", "name": "Earned Value", "custom": True,
     "schema": {"type": "number", "custom": "com.atlassian.jira.plugin.system.customfieldtypes:float", "customId": 10501}},
]

STATUSES = {
    "To Do": "new",
    "In Progress": "indeterminate",
    "In Review": "indeterminate",
    "Done": "done",
}
STATUS_IDS = {"To Do": "1", "In Progress": "3", "In Review": "10001", "Done": "10002"}
CATEGORY_NAMES = {"new": "To Do", "indeterminate": "In Progress", "done": "Done"}
CATEGORY_IDS = {"new": 2, "indeterminate": 4, "done": 3}

PEOPLE = ["Priya Shah", "Tom Becker", "Marcus Lee", "Dana Ortiz", "Joe Rinaldi"]

# Link types as Jira describes them. Which end is "inward" differs from type to type.
LINK_TYPES = [
    {"id": "10000", "name": "Blocks", "inward": "is blocked by", "outward": "blocks"},
    {"id": "10001", "name": "Dependency", "inward": "is depended on by", "outward": "depends on"},
    {"id": "10003", "name": "Relates", "inward": "relates to", "outward": "relates to"},
]

SPRINT_DAYS = 14
SPRINT_ANCHOR = date(2026, 1, 5)  # a Monday

BOARDS = [
    {"id": 1, "name": "Platform board", "type": "scrum", "project": "PLAT", "subQuery": None,
     "columns": [("To Do", ["To Do"], 0), ("In Progress", ["In Progress"], 5),
                 ("In Review", ["In Review"], 2), ("Done", ["Done"], 0)]},
    {"id": 2, "name": "Data board", "type": "kanban", "project": "DATA", "subQuery": None,
     "columns": [("Backlog", ["To Do"], 0), ("Doing", ["In Progress", "In Review"], 3), ("Done", ["Done"], 0)]},
]


def status_json(name: str) -> dict:
    category = STATUSES[name]
    return {"id": STATUS_IDS[name], "name": name,
            "statusCategory": {"id": CATEGORY_IDS[category], "key": category, "name": CATEGORY_NAMES[category]}}


def stamp(value: datetime) -> str:
    """Jira's timestamp format."""
    return value.strftime("%Y-%m-%dT%H:%M:%S.000+0000")


def quarter_pi(day: date, offset: int = 0) -> dict:
    """PIs follow calendar quarters: "PI 26.4" is the fourth quarter of 2026."""
    index = day.year * 4 + (day.month - 1) // 3 + offset
    year, q = divmod(index, 4)
    start = date(year, q * 3 + 1, 1)
    nxt = date(year + (q == 3), (q * 3 + 3) % 12 + 1, 1)
    return {"name": f"PI {year % 100}.{q + 1}", "start": start.isoformat(), "end": (nxt - timedelta(days=1)).isoformat()}


class Dataset:
    def __init__(self, today: Optional[date] = None, seed: int = 7):
        self.today = today or date.today()
        # History never runs past the start of today, so nothing is ever in the future.
        self.now = datetime.combine(self.today, time(0, 0), timezone.utc)
        self.issues: list[dict] = []
        self._ids = 10000
        self._numbers: dict[str, int] = {}
        self._rng = random.Random(seed)

        index = (self.today - SPRINT_ANCHOR).days // SPRINT_DAYS
        self.sprints = []
        for offset, state in ((-1, "closed"), (0, "active"), (1, "future")):
            start = SPRINT_ANCHOR + timedelta(days=(index + offset) * SPRINT_DAYS)
            self.sprints.append({
                "id": index + offset + 1, "name": f"Sprint {index + offset + 1}", "state": state,
                "startDate": f"{start.isoformat()}T09:00:00.000Z",
                "endDate": f"{(start + timedelta(days=SPRINT_DAYS - 1)).isoformat()}T17:00:00.000Z",
                "originBoardId": 1,
            })
        self.boards = [{"id": b["id"], "name": b["name"], "type": b["type"]} for b in BOARDS]
        self.pis = [quarter_pi(self.today, o) for o in (-1, 0, 1)]
        self._build()

    # ---- construction ----

    def _sprint_start(self, sprint_id: int) -> datetime:
        sprint = next(s for s in self.sprints if s["id"] == sprint_id)
        return datetime.fromisoformat(sprint["startDate"].replace(".000Z", "+00:00"))

    def _add(self, project: str, itype: str, summary: str, status: str = "To Do", **extra: Any) -> dict:
        self._ids += 1
        self._numbers[project] = self._numbers.get(project, 0) + 1
        issue = {"id": str(self._ids), "key": f"{project}-{self._numbers[project]}", "project": project,
                 "type": itype, "summary": summary, "status": status, "epic": None, "parent_link": None,
                 "parent": None, "points": None, "sprints": [], "pi": None,
                 "assignee": None, "labels": [], "blocked_by": [], "links": [], "flagged": False,
                 "created": self.now - timedelta(days=90), "history": [], "resolved": None}
        issue.update(extra)
        self.issues.append(issue)
        return issue

    def _log(self, issue: dict, at: datetime, field: str, old: Any, new: Any) -> None:
        issue["history"].append({"at": min(at, self.now), "field": field, "from": old, "to": new})

    def _life(self, issue: dict, status: str, sprints: list[int]) -> None:
        """Give an issue a believable past that ends in its current status."""
        rng = self._rng
        closed, active, _future = (s["id"] for s in self.sprints)
        days = lambda lo, hi: timedelta(hours=rng.randint(int(lo * 24), int(hi * 24)))  # noqa: E731
        if status == "Done":
            if closed in sprints:
                start = self._sprint_start(closed)
                done = start + days(2, SPRINT_DAYS - 1)
            else:
                start = self._sprint_start(active)
                done = start + timedelta(seconds=rng.random() * max(3600.0, (self.now - start).total_seconds()))
            done = min(done, self.now - timedelta(hours=1))
            began = done - days(1, 8)
            issue["created"] = began - days(2, 25)
            self._log(issue, began, "status", "To Do", "In Progress")
            if rng.random() < 0.6:
                self._log(issue, began + (done - began) * 0.7, "status", "In Progress", "In Review")
                self._log(issue, done, "status", "In Review", "Done")
            else:
                self._log(issue, done, "status", "In Progress", "Done")
            issue["resolved"] = done
            if rng.random() < 0.2:  # was blocked for a while on the way
                flag_on = began + (done - began) * 0.2
                self._log(issue, flag_on, "Flagged", "", "Impediment")
                self._log(issue, min(flag_on + days(0.5, 3), done), "Flagged", "Impediment", "")
        elif status in ("In Progress", "In Review"):
            began = self.now - days(0.5, 7)
            issue["created"] = began - days(2, 20)
            self._log(issue, began, "status", "To Do", "In Progress")
            if status == "In Review":
                self._log(issue, began + (self.now - began) * 0.6, "status", "In Progress", "In Review")
        else:
            issue["created"] = self.now - days(3, 30)
        # Sprint membership: mostly planned in, sometimes added after the sprint started.
        if sprints:
            sprint_id = sprints[0]
            start = self._sprint_start(sprint_id)
            if sprint_id == active and rng.random() < 0.25 and self.now - start > timedelta(days=1):
                added = start + timedelta(seconds=rng.uniform(86400, (self.now - start).total_seconds()))
                issue["created"] = min(issue["created"], added)
                self._log(issue, added, "Sprint", "", str(sprint_id))
                issue["labels"].append("unplanned")
            else:
                planned = min(start - timedelta(days=2), self.now)
                issue["created"] = min(issue["created"], planned - timedelta(hours=1))
                self._log(issue, planned, "Sprint", "", str(sprint_id))
        issue["history"].sort(key=lambda h: h["at"])

    def _stories(self, epic: dict, count: int, done_share: float, active_share: float) -> None:
        closed, active, future = (s["id"] for s in self.sprints)
        verbs = ["Build", "Design", "Test", "Document", "Review", "Wire up", "Harden", "Migrate"]
        for n in range(count):
            roll = self._rng.random()
            if roll < done_share:
                status, sprints = "Done", [closed] if self._rng.random() < 0.6 else [active]
            elif roll < done_share + active_share:
                status, sprints = self._rng.choice(["In Progress", "In Progress", "In Review"]), [active]
            else:
                status, sprints = "To Do", self._rng.choice([[active], [future], []])
            points = self._rng.choice([1, 2, 3, 3, 5, 5, 8, None])
            itype = "Bug" if self._rng.random() < 0.12 else "Story"
            story = self._add(epic["project"], itype, f"{verbs[n % len(verbs)]} {epic['summary'].lower()} part {n + 1}",
                              status, epic=epic["key"], points=points, sprints=sprints,
                              assignee=self._rng.choice(PEOPLE) if status != "To Do" or self._rng.random() < 0.4 else None)
            self._life(story, status, sprints)
            if n == 0 and count >= 6:
                for part, st in (("frontend", "Done"), ("backend", "In Progress")):
                    self._add(epic["project"], "Sub-task", f"{story['summary']}: {part}", st, parent=story["key"],
                              created=story["created"])

    def _build(self) -> None:
        prev_pi, cur_pi, next_pi = (p["name"] for p in self.pis)
        plat = self._add("PLAT", "Initiative", "Feature proposal pipeline", "In Progress")       # PLAT-1
        plan = [
            ("Proposal intake", cur_pi, 9, 0.75, 0.2),
            ("AI review service", cur_pi, 12, 0.4, 0.3),
            ("Approval workflow", cur_pi, 8, 0.15, 0.25),
            ("Jira epic preview", cur_pi, 6, 0.0, 0.2),
            ("Pipeline hosting and sign-in", prev_pi, 7, 1.0, 0.0),
            ("Audit and reporting", next_pi, 5, 0.0, 0.0),
        ]
        for summary, pi, count, done, active in plan:
            status = "Done" if done >= 1 else ("In Progress" if done or active else "To Do")
            epic = self._add("PLAT", "Epic", summary, status, parent_link=plat["key"], pi=pi)
            self._stories(epic, count, done, active)
        # An epic that has been planned but has no stories yet.
        self._add("PLAT", "Epic", "Template library", "To Do", parent_link=plat["key"], pi=cur_pi)

        data = self._add("DATA", "Initiative", "Data platform modernization", "In Progress")     # DATA-1
        for summary, pi, count, done, active in [
            ("Canonical data models", cur_pi, 10, 0.8, 0.15),
            ("Ingestion pipelines", cur_pi, 9, 0.55, 0.3),
            ("Access controls", next_pi, 6, 0.0, 0.1),
        ]:
            status = "In Progress" if done or active else "To Do"
            epic = self._add("DATA", "Epic", summary, status, parent_link=data["key"], pi=pi)
            self._stories(epic, count, done, active)

        # Two things in the way right now: one flagged, one waiting on another issue.
        doing = [i for i in self.issues if i["project"] == "PLAT" and i["status"] == "In Progress"
                 and i["type"] in ("Story", "Bug")]
        if doing:
            flagged = doing[0]
            flagged["flagged"] = True
            self._log(flagged, self.now - timedelta(days=2), "Flagged", "", "Impediment")
            flagged["history"].sort(key=lambda h: h["at"])
        if len(doing) > 1:
            blocker = next((i for i in self.issues if i["project"] == "PLAT" and i["status"] == "To Do"
                            and i["type"] == "Story"), None)
            if blocker:
                doing[1]["blocked_by"].append(blocker["key"])

        # Dependencies between the two programs, as "Dependency" links ("A depends on B"): one still
        # open across projects, one already settled, and a "Relates" link that is not a dependency.
        # Chosen by position, without the random generator, so the rest of the data stays as it was.
        def pick(project: str, status: str, skip: int = 0) -> Optional[dict]:
            found = [i for i in self.issues if i["project"] == project and i["status"] == status
                     and i["type"] in ("Story", "Bug")]
            return found[skip] if len(found) > skip else None
        waiting, provider = pick("DATA", "To Do"), pick("PLAT", "To Do", 1)
        if waiting and provider:
            waiting["links"].append(("Dependency", provider["key"]))
        started, finished = pick("PLAT", "In Progress", 2), pick("DATA", "Done")
        if started and finished:
            started["links"].append(("Dependency", finished["key"]))
        first, second = pick("PLAT", "Done"), pick("DATA", "Done", 1)
        if first and second:
            first["links"].append(("Relates", second["key"]))

    # ---- Jira JSON ----

    def by_key(self, key: str) -> Optional[dict]:
        return next((i for i in self.issues if i["key"] == key.upper()), None)

    def updated(self, issue: dict) -> datetime:
        return issue["history"][-1]["at"] if issue["history"] else issue["created"]

    def category_changed(self, issue: dict) -> datetime:
        changed = issue["created"]
        for h in issue["history"]:
            if h["field"] == "status" and STATUSES[h["from"]] != STATUSES[h["to"]]:
                changed = h["at"]
        return changed

    def to_json(self, issue: dict, base_url: str, fields: Optional[list[str]] = None,
                changelog: bool = False) -> dict:
        parent = self.by_key(issue["parent"]) if issue["parent"] else None
        links = []
        for n, key in enumerate(issue["blocked_by"]):
            other = self.by_key(key)
            if other:
                links.append({"id": f"{issue['id']}{n}",
                              "type": {"name": "Blocks", "inward": "is blocked by", "outward": "blocks"},
                              "inwardIssue": {"id": other["id"], "key": other["key"],
                                              "fields": {"summary": other["summary"],
                                                         "status": status_json(other["status"])}}})
        # Jira shows a link on both issues. "Blocks" puts the blocker in the inward slot of the
        # blocked issue; "Dependency" puts the issue depended on in the outward slot.
        def linked(other: dict) -> dict:
            return {"id": other["id"], "key": other["key"],
                    "fields": {"summary": other["summary"], "status": status_json(other["status"]),
                               "issuetype": {"name": other["type"], "subtask": other["type"] == "Sub-task"}}}
        types = {t["name"]: {k: t[k] for k in ("name", "inward", "outward")} for t in LINK_TYPES}
        for other in self.issues:
            if issue["key"] in other["blocked_by"]:
                links.append({"id": f"{other['id']}b{issue['id']}", "type": types["Blocks"], "outwardIssue": linked(other)})
            for name, key in other["links"]:
                if key == issue["key"]:
                    links.append({"id": f"{other['id']}l{issue['id']}", "type": types[name], "inwardIssue": linked(other)})
        for name, key in issue["links"]:
            other = self.by_key(key)
            if other:
                links.append({"id": f"{issue['id']}l{other['id']}", "type": types[name], "outwardIssue": linked(other)})
        full = {
            "summary": issue["summary"],
            "status": status_json(issue["status"]),
            "issuetype": {"name": issue["type"], "subtask": issue["type"] == "Sub-task"},
            "assignee": ({"name": issue["assignee"].split()[0].lower(), "displayName": issue["assignee"]}
                         if issue["assignee"] else None),
            "labels": list(issue["labels"]),
            "issuelinks": links,
            "created": stamp(issue["created"]),
            "updated": stamp(self.updated(issue)),
            "resolutiondate": stamp(issue["resolved"]) if issue["resolved"] else None,
            "statuscategorychangedate": stamp(self.category_changed(issue)),
            EPIC_LINK: issue["epic"],
            PARENT_LINK: issue["parent_link"],
            SPRINT: [{"id": s, "name": f"Sprint {s}"} for s in issue["sprints"]] or None,
            STORY_POINTS: issue["points"],
            FLAGGED: [{"value": "Impediment", "id": "10000"}] if issue["flagged"] else None,
            PI_FIELD: {"value": issue["pi"], "id": "2" + issue["pi"][-1]} if issue["pi"] else None,
        }
        if parent:
            full["parent"] = {"id": parent["id"], "key": parent["key"]}
        wanted = full if not fields or "*all" in fields else {k: v for k, v in full.items() if k in fields}
        out = {"id": issue["id"], "key": issue["key"], "self": f"{base_url}/rest/api/2/issue/{issue['id']}",
               "fields": wanted}
        if changelog:
            histories = []
            for n, h in enumerate(issue["history"]):
                item = {"field": h["field"], "fieldtype": "jira" if h["field"] == "status" else "custom"}
                if h["field"] == "status":
                    item.update({"from": STATUS_IDS[h["from"]], "fromString": h["from"],
                                 "to": STATUS_IDS[h["to"]], "toString": h["to"]})
                elif h["field"] == "Sprint":
                    item.update({"from": h["from"], "fromString": f"Sprint {h['from']}" if h["from"] else "",
                                 "to": h["to"], "toString": f"Sprint {h['to']}" if h["to"] else ""})
                else:
                    item.update({"from": "[10000]" if h["from"] else "", "fromString": h["from"],
                                 "to": "[10000]" if h["to"] else "", "toString": h["to"]})
                histories.append({"id": f"{issue['id']}{n:02d}", "created": stamp(h["at"]), "items": [item]})
            out["changelog"] = {"startAt": 0, "maxResults": len(histories), "total": len(histories),
                                "histories": histories}
        return out

    def board_config(self, board_id: int) -> Optional[dict]:
        board = next((b for b in BOARDS if b["id"] == board_id), None)
        if not board:
            return None
        out = {
            "id": board["id"], "name": board["name"], "type": board["type"],
            "filter": {"id": str(10100 + board["id"])},
            "columnConfig": {
                "columns": [{"name": name, "statuses": [{"id": STATUS_IDS[s]} for s in statuses],
                             **({"max": wip} if wip else {})} for name, statuses, wip in board["columns"]],
                "constraintType": "issueCount",
            },
        }
        if board["subQuery"]:
            out["subQuery"] = {"query": board["subQuery"]}
        return out

    def board_project(self, board_id: int) -> Optional[str]:
        board = next((b for b in BOARDS if b["id"] == board_id), None)
        return board["project"] if board else None
