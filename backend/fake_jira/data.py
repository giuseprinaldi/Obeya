"""Sample Jira data: two initiatives, their epics, stories and a few sub-tasks."""
from __future__ import annotations

import random
from datetime import date, timedelta
from typing import Any, Optional

EPIC_LINK = "customfield_10101"
PARENT_LINK = "customfield_10102"
SPRINT = "customfield_10104"
STORY_POINTS = "customfield_10106"
PI_FIELD = "customfield_10500"

FIELDS = [
    {"id": "summary", "name": "Summary", "custom": False, "schema": {"type": "string", "system": "summary"}},
    {"id": "status", "name": "Status", "custom": False, "schema": {"type": "status", "system": "status"}},
    {"id": "issuetype", "name": "Issue Type", "custom": False, "schema": {"type": "issuetype", "system": "issuetype"}},
    {"id": "parent", "name": "Parent", "custom": False},
    {"id": EPIC_LINK, "name": "Epic Link", "custom": True,
     "schema": {"type": "any", "custom": "com.pyxis.greenhopper.jira:gh-epic-link", "customId": 10101}},
    {"id": PARENT_LINK, "name": "Parent Link", "custom": True,
     "schema": {"type": "any", "custom": "com.atlassian.jpo:jpo-custom-field-parent", "customId": 10102}},
    {"id": SPRINT, "name": "Sprint", "custom": True,
     "schema": {"type": "array", "custom": "com.pyxis.greenhopper.jira:gh-sprint", "customId": 10104}},
    {"id": STORY_POINTS, "name": "Story Points", "custom": True,
     "schema": {"type": "number", "custom": "com.atlassian.jira.plugin.system.customfieldtypes:float", "customId": 10106}},
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
CATEGORY_NAMES = {"new": "To Do", "indeterminate": "In Progress", "done": "Done"}

SPRINT_DAYS = 14
SPRINT_ANCHOR = date(2026, 1, 5)  # a Monday


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
        self.boards = [{"id": 1, "name": "Platform board", "type": "scrum"},
                       {"id": 2, "name": "Data board", "type": "kanban"}]
        self.pis = [quarter_pi(self.today, o) for o in (-1, 0, 1)]
        self._build()

    # ---- construction ----

    def _add(self, project: str, itype: str, summary: str, status: str = "To Do", **extra: Any) -> dict:
        self._ids += 1
        self._numbers[project] = self._numbers.get(project, 0) + 1
        issue = {"id": str(self._ids), "key": f"{project}-{self._numbers[project]}", "project": project,
                 "type": itype, "summary": summary, "status": status, "epic": None, "parent_link": None,
                 "parent": None, "points": None, "sprints": [], "pi": None}
        issue.update(extra)
        self.issues.append(issue)
        return issue

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
            story = self._add(epic["project"], "Story", f"{verbs[n % len(verbs)]} {epic['summary'].lower()} part {n + 1}",
                              status, epic=epic["key"], points=points, sprints=sprints)
            if n == 0 and count >= 6:
                for part, st in (("frontend", "Done"), ("backend", "In Progress")):
                    self._add(epic["project"], "Sub-task", f"{story['summary']}: {part}", st, parent=story["key"])

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

    # ---- Jira JSON ----

    def by_key(self, key: str) -> Optional[dict]:
        return next((i for i in self.issues if i["key"] == key.upper()), None)

    def to_json(self, issue: dict, base_url: str, fields: Optional[list[str]] = None) -> dict:
        category = STATUSES[issue["status"]]
        parent = self.by_key(issue["parent"]) if issue["parent"] else None
        full = {
            "summary": issue["summary"],
            "status": {"name": issue["status"],
                       "statusCategory": {"key": category, "name": CATEGORY_NAMES[category]}},
            "issuetype": {"name": issue["type"], "subtask": issue["type"] == "Sub-task"},
            EPIC_LINK: issue["epic"],
            PARENT_LINK: issue["parent_link"],
            SPRINT: [{"id": s, "name": f"Sprint {s}"} for s in issue["sprints"]] or None,
            STORY_POINTS: issue["points"],
            PI_FIELD: {"value": issue["pi"], "id": "2" + issue["pi"][-1]} if issue["pi"] else None,
        }
        if parent:
            full["parent"] = {"id": parent["id"], "key": parent["key"]}
        wanted = full if not fields or "*all" in fields else {k: v for k, v in full.items() if k in fields}
        return {"id": issue["id"], "key": issue["key"], "self": f"{base_url}/rest/api/2/issue/{issue['id']}",
                "fields": wanted}
