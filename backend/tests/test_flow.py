"""Flow maths on hand-built issue histories, then boards and metrics against the fake Jira."""
import threading
import unittest
from datetime import date, datetime, timedelta, timezone

from fake_jira.data import STATUSES, STATUS_IDS, status_json, stamp
from fake_jira.server import DEFAULT_TOKEN, make_fake_server, suggested_settings
from obeya import flow
from obeya.jira_client import JiraClient
from obeya.sources import Engine, normalize_board, normalize_metric

CATS = {STATUS_IDS[name]: cat for name, cat in STATUSES.items()}
T0 = datetime(2026, 11, 1, 9, 0, tzinfo=timezone.utc)


def day(n: float) -> datetime:
    return T0 + timedelta(days=n)


def issue(key, created, moves=(), flags=(), sprints=(), status=None, **fields):
    """moves: (day, from, to); flags: (day, on); sprints: (day, from ids, to ids)."""
    histories = []
    for at, old, new in moves:
        histories.append({"created": stamp(day(at)), "items": [
            {"field": "status", "from": STATUS_IDS[old], "fromString": old, "to": STATUS_IDS[new], "toString": new}]})
    for at, on in flags:
        histories.append({"created": stamp(day(at)), "items": [
            {"field": "Flagged", "fromString": "" if on else "Impediment", "toString": "Impediment" if on else ""}]})
    for at, old, new in sprints:
        histories.append({"created": stamp(day(at)), "items": [{"field": "Sprint", "from": old, "to": new}]})
    current = status or (moves[-1][2] if moves else "To Do")
    return {"key": key, "fields": {"created": stamp(day(created)), "status": status_json(current),
                                   "issuetype": {"name": "Story", "subtask": False}, **fields},
            "changelog": {"histories": histories}}


def tl(*args, **kwargs):
    return flow.timeline(issue(*args, **kwargs), CATS)


class Timestamps(unittest.TestCase):
    def test_formats(self):
        expected = datetime(2026, 11, 2, 9, 15, 30, tzinfo=timezone.utc)
        for text in ("2026-11-02T09:15:30.000+0000", "2026-11-02T09:15:30+00:00", "2026-11-02T09:15:30.000Z",
                     "2026-11-02T10:15:30.000+0100", "2026-11-02T09:15:30"):
            self.assertEqual(flow.parse_ts(text), expected, text)
        for bad in (None, "", "yesterday", 12):
            self.assertIsNone(flow.parse_ts(bad))


class DoneAndStarted(unittest.TestCase):
    def test_plain_story(self):
        t = tl("A", 0, [(2, "To Do", "In Progress"), (5, "In Progress", "In Review"), (6, "In Review", "Done")])
        self.assertEqual(flow.done_at(t, day(10)), day(6))
        self.assertEqual(flow.started_at(t, day(6)), day(2))
        self.assertIsNone(flow.done_at(t, day(5.5)))          # not done yet at that point in time

    def test_reopened_work_is_done_when_it_is_finished_again(self):
        t = tl("A", 0, [(1, "To Do", "In Progress"), (3, "In Progress", "Done"),
                        (4, "Done", "In Progress"), (8, "In Progress", "Done")])
        self.assertEqual(flow.done_at(t, day(10)), day(8))
        self.assertEqual(flow.done_at(t, day(3.5)), day(3))   # as it looked before it was reopened
        self.assertIsNone(flow.done_at(t, day(5)))
        self.assertEqual(flow.started_at(t, day(8)), day(1))  # cycle time runs from the first start

    def test_straight_to_done_has_no_start(self):
        t = tl("A", 0, [(4, "To Do", "Done")])
        self.assertEqual(flow.done_at(t, day(10)), day(4))
        self.assertIsNone(flow.started_at(t, day(4)))

    def test_never_moved(self):
        t = tl("A", 0)
        self.assertIsNone(flow.done_at(t, day(10)))
        self.assertIsNone(flow.started_at(t, day(10)))

    def test_created_already_done(self):
        t = tl("A", 2, status="Done")
        self.assertEqual(flow.done_at(t, day(10)), day(2))

    def test_custom_done_statuses(self):
        t = tl("A", 0, [(1, "To Do", "In Progress"), (3, "In Progress", "In Review"), (7, "In Review", "Done")])
        # If "In Review" already counts as done, the work finished on day 3.
        self.assertEqual(flow.done_at(t, day(10), ["in review", "Done"]), day(3))
        # If only a status the issue never reached counts, it is not done, and "Done" is just work in progress.
        self.assertIsNone(flow.done_at(t, day(10), ["Released"]))


class Blocked(unittest.TestCase):
    RULE = {"flagged": True, "statuses": [], "labels": [], "links": False}

    def test_flag_periods_are_clipped_to_the_window(self):
        t = tl("A", 0, flags=[(1, True), (3, False), (8, True)])
        self.assertEqual(flow.blocked_seconds(t, day(0), day(10), self.RULE), 4 * flow.DAY)   # days 1-3 and 8-10
        self.assertEqual(flow.blocked_seconds(t, day(2), day(9), self.RULE), 2 * flow.DAY)    # 2-3 and 8-9
        self.assertEqual(flow.blocked_seconds(t, day(4), day(7), self.RULE), 0)
        self.assertEqual(flow.blocked_seconds(t, day(5), day(5), self.RULE), 0)

    def test_flag_and_status_overlap_is_counted_once(self):
        rule = {"flagged": True, "statuses": ["In Review"], "labels": [], "links": False}
        t = tl("A", 0, [(1, "To Do", "In Progress"), (2, "In Progress", "In Review"), (6, "In Review", "Done")],
               flags=[(4, True), (8, False)])
        # "In Review" covers days 2-6, the flag covers 4-8: together 2-8.
        self.assertEqual(flow.blocked_seconds(t, day(0), day(10), rule), 6 * flow.DAY)

    def test_rule_switched_off(self):
        t = tl("A", 0, flags=[(1, True)])
        self.assertEqual(flow.blocked_seconds(t, day(0), day(10), {"flagged": False, "statuses": []}), 0)

    def test_reasons_right_now(self):
        rule = {"flagged": True, "statuses": ["On hold"], "labels": ["blocked"], "links": True}
        base = issue("A", 0, status="In Progress")
        self.assertEqual(flow.blocked_reason(base, rule, "cf_flag"), "")
        flagged = issue("A", 0, status="In Progress", cf_flag=[{"value": "Impediment"}])
        self.assertEqual(flow.blocked_reason(flagged, rule, "cf_flag"), "Flagged")
        self.assertEqual(flow.blocked_reason(flagged, {**rule, "flagged": False}, "cf_flag"), "")
        labelled = issue("A", 0, status="In Progress", labels=["Blocked"])
        self.assertEqual(flow.blocked_reason(labelled, rule, "cf_flag"), "Label: Blocked")
        link = {"type": {"inward": "is blocked by"}, "inwardIssue": {"key": "B-2", "fields": {"status": status_json("To Do")}}}
        self.assertEqual(flow.blocked_reason(issue("A", 0, issuelinks=[link]), rule, ""), "Blocked by B-2")
        resolved = {"type": {"inward": "is blocked by"}, "inwardIssue": {"key": "B-2", "fields": {"status": status_json("Done")}}}
        self.assertEqual(flow.blocked_reason(issue("A", 0, issuelinks=[resolved]), rule, ""), "")
        outward = {"type": {"inward": "is blocked by", "outward": "blocks"}, "outwardIssue": {"key": "B-3"}}
        self.assertEqual(flow.blocked_reason(issue("A", 0, issuelinks=[outward]), rule, ""), "")   # A blocks B-3

    def test_rule_cleaning(self):
        self.assertEqual(flow.clean_blocked_rule(None), {"flagged": True, "statuses": [], "labels": [], "links": False})
        self.assertEqual(flow.clean_blocked_rule({"flagged": False, "statuses": [" On hold ", ""], "labels": "x", "links": "yes"}),
                         {"flagged": False, "statuses": ["On hold"], "labels": [], "links": False})


class Sprints(unittest.TestCase):
    def test_joined(self):
        self.assertEqual(flow.joined_sprint(tl("A", 1), "23"), day(1))                               # created in it
        self.assertEqual(flow.joined_sprint(tl("A", 1, sprints=[(3, "", "23")]), "23"), day(3))
        moved = tl("A", 1, sprints=[(2, "", "22"), (9, "22", "22, 23")])
        self.assertEqual(flow.joined_sprint(moved, "23"), day(9))                                    # carried over
        back = tl("A", 1, sprints=[(2, "", "23"), (4, "23", ""), (6, "", "23")])
        self.assertEqual(flow.joined_sprint(back, "23"), day(6))                                     # removed, re-added


class Statistics(unittest.TestCase):
    def test_statistic(self):
        self.assertEqual(flow.statistic([3, 1, 2], "median"), 2)
        self.assertEqual(flow.statistic([4, 1, 2, 3], "median"), 2.5)
        self.assertEqual(flow.statistic([1, 2, 3, 6], "average"), 3)
        self.assertEqual(flow.statistic(range(1, 21), "p85"), 17)
        self.assertEqual(flow.statistic([5], "p85"), 5)
        self.assertIsNone(flow.statistic([], "median"))

    def test_lookback_values(self):
        timelines = [
            tl("A", 0, [(2, "To Do", "In Progress"), (6, "In Progress", "Done")]),      # cycle 4, lead 6
            tl("B", 1, [(3, "To Do", "In Progress"), (11, "In Progress", "Done")]),     # cycle 8, lead 10
            tl("C", 5, [(12, "To Do", "Done")]),                                        # no start; lead 7
            tl("D", 0, [(1, "To Do", "In Progress")], flags=[(2, True), (5, False)]),   # never finished
        ]
        rule = {"flagged": True, "statuses": []}
        args = (timelines, day(14), 14, "median", None, rule)
        self.assertEqual(flow.lookback_value("cycle_time", *args), (6.0, 2))      # C has no cycle time
        self.assertEqual(flow.lookback_value("lead_time", *args), (7.0, 3))
        self.assertEqual(flow.lookback_value("throughput", *args), (1.5, 3))      # 3 in two weeks
        self.assertEqual(flow.lookback_value("blocked_days", *args), (3.0, 1))
        # A week earlier only A had finished.
        earlier = (timelines, day(7), 14, "median", None, rule)
        self.assertEqual(flow.lookback_value("cycle_time", *earlier), (4.0, 1))
        self.assertEqual(flow.lookback_value("throughput", *earlier), (0.5, 1))
        # Nothing finished in a window that ends before any work was done.
        self.assertEqual(flow.lookback_value("cycle_time", timelines, day(1), 14, "median", None, rule), (None, 0))

    def test_percent(self):
        self.assertEqual(flow.percent(1, 4), 25)
        self.assertEqual(flow.percent(1, 3), 33.3)
        self.assertIsNone(flow.percent(0, 0))


class Burnup(unittest.TestCase):
    ITEMS = [
        (tl("A", 0, [(2, "To Do", "In Progress"), (4, "In Progress", "Done")]), 3.0),
        (tl("B", 1, [(3, "To Do", "Done"), (5, "Done", "In Progress"), (8, "In Progress", "Done")]), 5.0),
        (tl("C", 6), 2.0),                       # created late, never started
    ]

    def test_scope_grows_as_issues_are_created_and_done_follows_history(self):
        moments = [day(n + 0.5) for n in range(-1, 9)]   # half a day before A exists, then daily
        self.assertEqual(flow.burnup(self.ITEMS, moments), [
            (0, 0),      # nothing exists yet
            (0, 3),      # A
            (0, 8),      # A and B
            (0, 8),
            (5, 8),      # B done on day 3
            (8, 8),      # A done on day 4
            (3, 8),      # B reopened on day 5: no longer done
            (3, 10),     # C created
            (3, 10),
            (8, 10),     # B finished again
        ])

    def test_custom_done_statuses_and_nothing_to_replay(self):
        self.assertEqual(flow.burnup(self.ITEMS, [day(2.5), day(4.5)], ["In Progress"]), [(3, 8), (0, 8)])
        self.assertEqual(flow.burnup([], [day(1)]), [(0, 0)])
        self.assertEqual(flow.burnup(self.ITEMS, []), [])


# ---------- against the fake Jira ----------

TODAY = date.today()   # the engine measures ages and windows from the real clock


class FlowEngine(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_fake_server(port=0, today=TODAY)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"
        cls.ds = cls.server.dataset
        cls.client = JiraClient(cls.url, DEFAULT_TOKEN)
        cls.settings = suggested_settings(cls.ds)
        cls.active = cls.ds.sprints[1]["id"]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def engine(self, **jira):
        settings = {**self.settings, "jira": {**self.settings["jira"], **jira}}
        return Engine(self.client, settings, TODAY)

    def work(self, project="PLAT", sprint=None):
        return [i for i in self.ds.issues if i["project"] == project and i["type"] in ("Story", "Bug")
                and (sprint is None or sprint in i["sprints"])]

    # ---- boards ----

    def test_scrum_board_shows_the_active_sprint_in_board_columns(self):
        r = self.engine().compute(normalize_board({"boardId": 1}))
        self.assertTrue(r["ok"], r)
        self.assertEqual((r["boardName"], r["boardType"], r["sprint"]["name"]),
                         ("Platform board", "scrum", self.ds.sprints[1]["name"]))
        self.assertEqual([(c["name"], c["wip"]) for c in r["columns"]],
                         [("To Do", 0), ("In Progress", 5), ("In Review", 2), ("Done", 0)])
        in_sprint = self.work(sprint=self.active)
        for column in r["columns"]:
            self.assertEqual(column["total"], sum(1 for i in in_sprint if i["status"] == column["name"]), column["name"])
        self.assertEqual(r["total"], len(in_sprint))
        keys = {c["key"] for col in r["columns"] for c in col["cards"]}
        self.assertFalse(any(self.ds.by_key(k)["type"] in ("Epic", "Sub-task", "Initiative") for k in keys))

    def test_cards_carry_what_screens_need(self):
        r = self.engine().compute(normalize_board({"boardId": 1}))
        cards = {c["key"]: c for col in r["columns"] for c in col["cards"]}
        flagged = next(i for i in self.ds.issues if i["flagged"])
        linked = next(i for i in self.ds.issues if i["blocked_by"])
        self.assertEqual((cards[flagged["key"]]["blocked"], cards[flagged["key"]]["blockedReason"]), (True, "Flagged"))
        self.assertEqual(cards[linked["key"]]["blockedReason"], f"Blocked by {linked['blocked_by'][0]}")
        self.assertEqual(r["blocked"], 2)
        card = cards[flagged["key"]]
        self.assertEqual((card["title"], card["assignee"], card["type"]),
                         (flagged["summary"], flagged["assignee"], flagged["type"]))
        self.assertEqual(card["url"], f"{self.url}/browse/{flagged['key']}")
        self.assertIsInstance(card["ageDays"], int)
        self.assertGreaterEqual(card["ageDays"], 0)

    def test_cards_say_whether_work_is_under_way_and_how_long_since_it_was_touched(self):
        r = self.engine().compute(normalize_board({"boardId": 1}))
        now = datetime.now(timezone.utc)
        seen = 0
        for column in r["columns"]:
            for card in column["cards"]:
                issue = self.ds.by_key(card["key"])
                self.assertEqual(card["category"], STATUSES[issue["status"]], card["key"])
                # Whole days since Jira's "updated"; a second either side of midnight is allowed for.
                expected = (now - self.ds.updated(issue)).days
                self.assertIn(card["idleDays"], (expected, expected - 1, expected + 1), card["key"])
                self.assertGreaterEqual(card["idleDays"], 0)
                seen += 1
        self.assertGreater(seen, 5)
        doing = next(c for c in r["columns"] if c["name"] == "In Progress")
        self.assertTrue(all(c["category"] == "indeterminate" for c in doing["cards"]))
        # The flagged story was touched when it was flagged, two days before the fake Jira's "today",
        # if not since. That "today" is the local date, which in the evening west of Greenwich is a
        # day behind the UTC clock the engine counts from, hence three.
        flagged = next(i for i in self.ds.issues if i["flagged"])
        card = next(c for col in r["columns"] for c in col["cards"] if c["key"] == flagged["key"])
        self.assertLessEqual(card["idleDays"], 3)

    def test_privacy_switches_keep_names_and_summaries_on_the_server(self):
        r = self.engine(showSummaries=False, showAssignees=False).compute(normalize_board({"boardId": 1}))
        for col in r["columns"]:
            for card in col["cards"]:
                self.assertEqual((card["title"], card["assignee"]), (card["key"], ""))

    def test_blocked_rule_is_configurable(self):
        off = {"flagged": False, "statuses": [], "labels": [], "links": False}
        self.assertEqual(self.engine(blocked=off).compute(normalize_board({"boardId": 1}))["blocked"], 0)
        by_status = {**off, "statuses": ["in review"]}
        r = self.engine(blocked=by_status).compute(normalize_board({"boardId": 1}))
        review = next(c for c in r["columns"] if c["name"] == "In Review")
        self.assertEqual(r["blocked"], review["total"])

    def test_hidden_columns_extra_query_and_whole_board(self):
        r = self.engine().compute(normalize_board({"boardId": 1, "hiddenColumns": ["to do", "Done"]}))
        self.assertEqual([c["name"] for c in r["columns"]], ["In Progress", "In Review"])
        bugs = self.engine().compute(normalize_board({"boardId": 1, "jql": "issuetype = Bug ORDER BY created"}))
        self.assertEqual(bugs["total"], sum(1 for i in self.work(sprint=self.active) if i["type"] == "Bug"))
        everything = self.engine().compute(normalize_board({"boardId": 1, "sprint": "all", "doneDays": 0}))
        self.assertIsNone(everything["sprint"])
        self.assertEqual(everything["total"], len([i for i in self.ds.issues if i["project"] == "PLAT"
                                                   and i["type"] != "Sub-task"]))

    def test_kanban_board_merges_statuses_and_limits_done_by_age(self):
        r = self.engine().compute(normalize_board({"boardId": 2, "doneDays": 7}))
        self.assertEqual((r["boardType"], r["sprint"]), ("kanban", None))
        self.assertEqual([(c["name"], c["wip"]) for c in r["columns"]], [("Backlog", 0), ("Doing", 3), ("Done", 0)])
        data = [i for i in self.ds.issues if i["project"] == "DATA" and i["type"] != "Sub-task"]
        doing = next(c for c in r["columns"] if c["name"] == "Doing")
        self.assertEqual(doing["total"], sum(1 for i in data if i["status"] in ("In Progress", "In Review")))
        done = next(c for c in r["columns"] if c["name"] == "Done")
        all_done = self.engine().compute(normalize_board({"boardId": 2, "doneDays": 0}))["columns"][-1]
        self.assertLess(done["total"], all_done["total"])
        self.assertEqual(all_done["total"], sum(1 for i in data if i["status"] == "Done"))
        self.assertLessEqual(len(all_done["cards"]), 30)

    def test_board_errors(self):
        r = self.engine().compute(normalize_board({"boardId": 99}))
        self.assertEqual((r["ok"], r["columns"]), (False, []))
        self.assertIn("Board 99 was not found", r["error"])
        r = self.engine().compute(normalize_board({"boardId": 1, "jql": "nosuchfield = 1"}))
        self.assertFalse(r["ok"])
        self.assertIn("nosuchfield", r["error"])
        self.assertIsNone(normalize_board({"boardId": 0}))
        self.assertIsNone(normalize_board({"boardId": "1"}))

    # ---- right-now metrics ----

    def test_scope_done_by_points_matches_the_sprint(self):
        r = self.engine().compute(normalize_metric({"kind": "scope_done", "boardId": 1, "measure": "points"}))
        in_sprint = self.work(sprint=self.active)
        total = sum(i["points"] or 0 for i in in_sprint)
        done = sum(i["points"] or 0 for i in in_sprint if i["status"] == "Done")
        self.assertEqual((r["ok"], r["unit"], r["n"]), (True, "%", len(in_sprint)))
        self.assertEqual(r["value"], flow.percent(done, total))
        self.assertEqual(r["detail"], f"{done} of {total} points done")

    def test_wip_and_blocked_now(self):
        in_sprint = self.work(sprint=self.active)
        r = self.engine().compute(normalize_metric({"kind": "wip", "boardId": 1}))
        self.assertEqual(r["value"], sum(1 for i in in_sprint if i["status"] in ("In Progress", "In Review")))
        self.assertEqual(r["unit"], "items")
        r = self.engine().compute(normalize_metric({"kind": "blocked_now", "jql": "project = PLAT"}))
        self.assertEqual(r["value"], 2)
        self.assertIn(next(i["key"] for i in self.ds.issues if i["flagged"]), r["detail"])

    def test_unplanned_rules(self):
        in_sprint = self.work(sprint=self.active)
        start = self.ds._sprint_start(self.active)
        added_later = [i for i in in_sprint
                       if any(h["field"] == "Sprint" and h["at"].date() > start.date() for h in i["history"])]
        r = self.engine().compute(normalize_metric({"kind": "unplanned", "boardId": 1}))
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["value"], flow.percent(len(added_later), len(in_sprint)))
        self.assertIn("added after the sprint started", r["detail"])
        r = self.engine().compute(normalize_metric(
            {"kind": "unplanned", "boardId": 1, "unplanned": {"rule": "types", "values": ["bug"]}}))
        self.assertEqual(r["value"], flow.percent(sum(1 for i in in_sprint if i["type"] == "Bug"), len(in_sprint)))
        r = self.engine().compute(normalize_metric(
            {"kind": "unplanned", "jql": "project = PLAT", "unplanned": {"rule": "labels", "values": ["unplanned"]}}))
        plat = self.work()
        self.assertEqual(r["value"], flow.percent(sum(1 for i in plat if "unplanned" in i["labels"]), len(plat)))

    def test_added_after_start_needs_a_sprint(self):
        for metric in ({"kind": "unplanned", "jql": "project = PLAT"}, {"kind": "unplanned", "boardId": 2}):
            r = self.engine().compute(normalize_metric(metric))
            self.assertFalse(r["ok"])
            self.assertIn("needs a scrum board", r["error"])

    # ---- look-back metrics ----

    def finished(self, issues, days):
        cutoff = self.ds.now - timedelta(days=days)
        return [i for i in issues if i["resolved"] and i["resolved"] > cutoff]

    def test_throughput_counts_finished_work_across_sprints(self):
        r = self.engine().compute(normalize_metric({"kind": "throughput", "boardId": 1, "windowDays": 28}))
        self.assertTrue(r["ok"], r)
        # The window ends "now" while the sample data ends at midnight, so allow the edge of the window.
        expected = len(self.finished(self.work(), 28))
        self.assertLessEqual(abs(r["n"] - expected), 1)
        self.assertEqual(r["value"], round(r["n"] / 4, 1))
        self.assertEqual(r["unit"], "/ week")
        self.assertGreaterEqual(len(r["history"]), 4)
        self.assertEqual(r["history"][-1], {"d": datetime.now(timezone.utc).date().isoformat(), "value": r["value"]})
        self.assertEqual([h["d"] for h in r["history"]], sorted(h["d"] for h in r["history"]))

    def test_cycle_and_lead_time(self):
        cycle = self.engine().compute(normalize_metric({"kind": "cycle_time", "jql": "project = PLAT", "windowDays": 60}))
        lead = self.engine().compute(normalize_metric({"kind": "lead_time", "jql": "project = PLAT", "windowDays": 60}))
        self.assertTrue(cycle["ok"] and lead["ok"], (cycle, lead))
        done = self.finished(self.work(), 60)
        cycles = sorted((i["resolved"] - next(h["at"] for h in i["history"] if h["field"] == "status")).total_seconds() / 86400
                        for i in done)
        self.assertEqual(cycle["n"], len(done))
        self.assertAlmostEqual(cycle["value"], flow.statistic(cycles, "median"), delta=0.11)
        self.assertGreater(lead["value"], cycle["value"])
        self.assertEqual(cycle["unit"], "days")
        self.assertIn("Median start to done", cycle["detail"])
        p85 = self.engine().compute(normalize_metric(
            {"kind": "cycle_time", "jql": "project = PLAT", "windowDays": 60, "stat": "p85"}))
        self.assertGreaterEqual(p85["value"], cycle["value"])

    def test_nothing_finished_gives_no_value_rather_than_zero(self):
        r = self.engine().compute(normalize_metric({"kind": "cycle_time", "jql": "issuetype = Initiative"}))
        self.assertEqual((r["ok"], r["value"], r["n"], r["history"]), (True, None, 0, []))
        self.assertIn("No work finished", r["detail"])

    def test_blocked_days(self):
        r = self.engine().compute(normalize_metric({"kind": "blocked_days", "jql": "project = PLAT", "windowDays": 30}))
        self.assertTrue(r["ok"], r)
        self.assertGreaterEqual(r["value"], 2.0)   # one issue has been flagged for two days and still is
        self.assertGreaterEqual(r["n"], 1)
        off = {"flagged": False, "statuses": [], "labels": [], "links": True}
        r = self.engine(blocked=off).compute(normalize_metric({"kind": "blocked_days", "jql": "project = PLAT"}))
        self.assertFalse(r["ok"])
        self.assertIn("Blocked means", r["error"])

    def test_metric_validation(self):
        self.assertIsNone(normalize_metric({"kind": "cycle_time"}))                 # no scope
        self.assertIsNone(normalize_metric({"kind": "velocity", "boardId": 1}))     # not a metric we have
        spec = normalize_metric({"kind": "throughput", "boardId": 1, "windowDays": 9999, "stat": "p85", "measure": "points"})
        self.assertEqual(spec, {"kind": "metric", "metric": "throughput", "boardId": 1, "jql": "",
                                "doneStatuses": [], "windowDays": 365})
        r = self.engine().compute(normalize_metric({"kind": "wip", "jql": "nosuchfield = 1"}))
        self.assertFalse(r["ok"])


class MidSprint(unittest.TestCase):
    """A fixed date nine days into a sprint, so some work has been added after it started."""

    def test_added_after_start_is_measured_from_sprint_history(self):
        server = make_fake_server(port=0, today=date(2026, 11, 18))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            ds = server.dataset
            engine = Engine(JiraClient(f"http://127.0.0.1:{server.server_address[1]}", DEFAULT_TOKEN),
                            suggested_settings(ds), date(2026, 11, 18))
            active = ds.sprints[1]["id"]
            start = ds._sprint_start(active)
            in_sprint = [i for i in ds.issues if i["project"] == "PLAT" and i["type"] in ("Story", "Bug")
                         and active in i["sprints"]]
            late = [i for i in in_sprint
                    if any(h["field"] == "Sprint" and h["at"].date() > start.date() for h in i["history"])]
            self.assertGreater(len(late), 0)
            self.assertLess(len(late), len(in_sprint))
            by_count = engine.compute(normalize_metric({"kind": "unplanned", "boardId": 1}))
            self.assertEqual(by_count["value"], flow.percent(len(late), len(in_sprint)))
            self.assertEqual(by_count["detail"], f"{len(late)} of {len(in_sprint)} items added after the sprint started")
            by_points = engine.compute(normalize_metric({"kind": "unplanned", "boardId": 1, "measure": "points"}))
            self.assertEqual(by_points["value"], flow.percent(sum(i["points"] or 0 for i in late),
                                                              sum(i["points"] or 0 for i in in_sprint)))
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
