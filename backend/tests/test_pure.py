"""Pure logic: PI calendar, JQL variables, progress maths, link parsing."""
import unittest
from datetime import date

from obeya.periods import TemplateError, clean_calendar, field_ref, period_range, pick_pis, resolve_jql, sprint_period
from obeya.progress import issue_view, tally, work_items
from obeya.sources import normalize_auto, normalize_key, normalize_source, spec_id, text_values, _pointer
from obeya.sync import collect_links

PIS = clean_calendar([
    {"name": "PI 26.4", "start": "2026-10-05", "end": "2026-12-13"},
    {"name": "PI 26.3", "start": "2026-07-13", "end": "2026-09-20"},
    {"name": "PI 27.1", "start": "2027-01-04", "end": "2027-03-14"},
    {"name": "", "start": "2026-01-01", "end": "2026-02-01"},          # no name
    {"name": "Backwards", "start": "2026-05-01", "end": "2026-04-01"},  # ends before it starts
    "junk",
])


def item(key, status="To Do", category="new", points=None, subtask=False):
    return {"key": key, "id": key, "summary": key, "type": "Story", "subtask": subtask,
            "status": status, "category": category, "points": points}


class Calendar(unittest.TestCase):
    def test_clean_drops_bad_rows_and_sorts(self):
        self.assertEqual([p["name"] for p in PIS], ["PI 26.3", "PI 26.4", "PI 27.1"])

    def test_inside_a_pi(self):
        prev, cur, nxt = pick_pis(PIS, date(2026, 11, 10))
        self.assertEqual((prev["name"], cur["name"], nxt["name"]), ("PI 26.3", "PI 26.4", "PI 27.1"))

    def test_first_and_last_day_are_inside(self):
        self.assertEqual(pick_pis(PIS, date(2026, 10, 5))[1]["name"], "PI 26.4")
        self.assertEqual(pick_pis(PIS, date(2026, 12, 13))[1]["name"], "PI 26.4")

    def test_gap_keeps_the_last_started_pi(self):
        prev, cur, nxt = pick_pis(PIS, date(2026, 12, 20))
        self.assertEqual((cur["name"], nxt["name"]), ("PI 26.4", "PI 27.1"))

    def test_after_the_calendar_ends(self):
        prev, cur, nxt = pick_pis(PIS, date(2028, 1, 1))
        self.assertEqual((prev["name"], cur["name"], nxt), ("PI 26.4", "PI 27.1", None))

    def test_before_the_calendar_starts(self):
        prev, cur, nxt = pick_pis(PIS, date(2025, 1, 1))
        self.assertEqual((prev, cur, nxt["name"]), (None, None, "PI 26.3"))

    def test_empty_calendar(self):
        self.assertEqual(pick_pis([], date(2026, 1, 1)), (None, None, None))

    def test_sprint_period(self):
        self.assertEqual(
            sprint_period({"name": "Sprint 14", "startDate": "2026-11-02T09:00:00.000Z", "endDate": "2026-11-15T17:00:00.000Z"}),
            {"name": "Sprint 14", "start": "2026-11-02", "end": "2026-11-15"})
        self.assertIsNone(sprint_period({"name": "No dates"}))
        self.assertIsNone(sprint_period(None))


class Templates(unittest.TestCase):
    TODAY = date(2026, 11, 10)

    def test_preset_resolves(self):
        out = resolve_jql('issuetype = Epic AND {PI_FIELD} = "{PI}"', "customfield_10500", PIS, self.TODAY)
        self.assertEqual(out, 'issuetype = Epic AND cf[10500] = "PI 26.4"')

    def test_next_and_previous(self):
        out = resolve_jql('{PI_FIELD} in ("{PREV_PI}", "{NEXT_PI}")', "customfield_10500", PIS, self.TODAY)
        self.assertEqual(out, 'cf[10500] in ("PI 26.3", "PI 27.1")')

    def test_rolls_over_with_the_date(self):
        out = resolve_jql('x = "{PI}"', "", PIS, date(2027, 1, 4))
        self.assertEqual(out, 'x = "PI 27.1"')

    def test_plain_jql_is_untouched(self):
        self.assertEqual(resolve_jql("sprint in openSprints()", "", [], self.TODAY), "sprint in openSprints()")

    def test_names_are_escaped_inside_quotes(self):
        pis = clean_calendar([{"name": 'PI "x" \\ y', "start": "2026-01-01", "end": "2026-12-31"}])
        self.assertEqual(resolve_jql('f = "{PI}"', "", pis, self.TODAY), 'f = "PI \\"x\\" \\\\ y"')

    def test_missing_field_or_calendar_explains_itself(self):
        with self.assertRaisesRegex(TemplateError, "PI field"):
            resolve_jql('{PI_FIELD} = "{PI}"', "", PIS, self.TODAY)
        with self.assertRaisesRegex(TemplateError, "calendar"):
            resolve_jql('{PI_FIELD} = "{PI}"', "customfield_1", [], self.TODAY)
        with self.assertRaisesRegex(TemplateError, "NEXT_PI"):
            resolve_jql('"{NEXT_PI}"', "", PIS, date(2027, 2, 1))

    def test_field_ref(self):
        self.assertEqual(field_ref("customfield_10500"), "cf[10500]")
        self.assertEqual(field_ref("fixVersion"), '"fixVersion"')


class Maths(unittest.TestCase):
    def test_count(self):
        t = tally([item("A", "Done", "done"), item("B", "In Progress", "indeterminate"), item("C")], "count")
        self.assertEqual((t["total"], t["done"], t["inProgress"], t["todo"], t["unit"]), (3, 1, 1, 1, "issues"))
        self.assertEqual(t["byStatus"], {"Done": 1, "In Progress": 1, "To Do": 1})

    def test_points_and_unestimated(self):
        t = tally([item("A", "Done", "done", 5), item("B", "In Progress", "indeterminate", 2.5), item("C")], "points")
        self.assertEqual((t["total"], t["done"], t["inProgress"], t["todo"]), (7.5, 5, 2.5, 0))
        self.assertEqual((t["issues"], t["unestimated"], t["unit"]), (3, 1, "points"))

    def test_custom_done_statuses(self):
        items = [item("A", "Released", "done"), item("B", "Done", "done"), item("C", "In Progress", "indeterminate")]
        t = tally(items, "count", ["released"])
        # "Done" no longer counts as done; it is work that has not been released yet.
        self.assertEqual((t["done"], t["inProgress"], t["todo"]), (1, 2, 0))

    def test_empty(self):
        t = tally([], "count")
        self.assertEqual((t["total"], t["done"], t["issues"]), (0, 0, 0))

    def test_work_items_replace_containers_with_children(self):
        root = item("INIT")
        children = {
            "INIT": [item("E1"), item("E2")],
            "E1": [item("S1", "Done", "done"), item("S2")],
            # E2 has no stories: it counts as one open item.
        }
        self.assertEqual([i["key"] for i in work_items(root, children)], ["S1", "S2", "E2"])

    def test_issue_without_children_counts_as_itself(self):
        self.assertEqual([i["key"] for i in work_items(item("X"), {})], ["X"])

    def test_cycles_do_not_loop(self):
        children = {"A": [item("B")], "B": [item("A"), item("C")]}
        self.assertEqual([i["key"] for i in work_items(item("A"), children)], ["C"])

    def test_issue_view(self):
        v = issue_view({"id": "1", "key": "P-1", "fields": {
            "summary": "S", "status": {"name": "Done", "statusCategory": {"key": "done"}},
            "issuetype": {"name": "Sub-task", "subtask": True}, "cf": 3, "bad": "x"}}, "cf")
        self.assertEqual((v["key"], v["category"], v["subtask"], v["points"]), ("P-1", "done", True, 3))
        self.assertIsNone(issue_view({"key": "P-2", "fields": {"bad": "x"}}, "bad")["points"])
        self.assertEqual(issue_view({}, "")["category"], "")


class Links(unittest.TestCase):
    def test_keys_and_urls(self):
        self.assertEqual(normalize_key(" plat-12 "), "PLAT-12")
        self.assertEqual(normalize_key("https://jira.example.com/browse/PLAT-12"), "PLAT-12")
        self.assertEqual(normalize_key("https://jira.example.com/secure/RapidBoard.jspa?rapidView=4&selectedIssue=DATA-7"), "DATA-7")
        self.assertEqual(normalize_key("nonsense"), "")
        self.assertEqual(normalize_key("PLAT-1 OR 1=1"), "PLAT-1")  # only the key survives into JQL

    def test_normalize_source(self):
        self.assertEqual(
            normalize_source({"kind": "issue", "key": "plat-1", "measure": "points", "doneStatuses": [" Done ", "", "done"]}),
            {"kind": "issue", "key": "PLAT-1", "measure": "points", "includeSubtasks": False, "doneStatuses": ["Done", "done"]})
        self.assertIsNone(normalize_source({"kind": "manual", "done": 1, "total": 2}))
        self.assertIsNone(normalize_source({"kind": "issue", "key": "???"}))
        self.assertIsNone(normalize_source({"kind": "jql", "jql": "  "}))
        self.assertIsNone(normalize_source("PLAT-1"))

    def test_descend_is_part_of_a_query_link_only_when_switched_on(self):
        plain = normalize_source({"kind": "jql", "jql": "project = PLAT"})
        self.assertNotIn("descend", plain)
        # A room saved by the editor says descend: false; that must still be the link it always was.
        self.assertEqual(spec_id(normalize_source({"kind": "jql", "jql": "project = PLAT", "descend": False})), spec_id(plain))
        deep = normalize_source({"kind": "jql", "jql": "project = PLAT", "descend": True})
        self.assertIs(deep["descend"], True)
        self.assertNotEqual(spec_id(deep), spec_id(plain))
        self.assertNotIn("descend", normalize_source({"kind": "jql", "jql": "project = PLAT", "descend": "yes"}))
        self.assertNotIn("descend", normalize_source({"kind": "issue", "key": "PLAT-1", "descend": True}))

    def test_normalize_auto_clamps_limit(self):
        self.assertEqual(normalize_auto({"jql": "x = 1", "limit": 5000})["limit"], 100)
        self.assertEqual(normalize_auto({"jql": "x = 1", "limit": "oops"})["limit"], 12)
        self.assertIsNone(normalize_auto({"jql": ""}))

    def test_same_link_same_id(self):
        a = normalize_source({"kind": "issue", "key": "PLAT-1", "measure": "count"})
        b = normalize_source({"kind": "issue", "key": "plat-1", "includeSubtasks": False, "doneStatuses": []})
        c = normalize_source({"kind": "issue", "key": "PLAT-1", "measure": "points"})
        self.assertEqual(spec_id(a), spec_id(b))
        self.assertNotEqual(spec_id(a), spec_id(c))

    def test_pointer_shapes(self):
        lookup = {"PLAT-1": "PLAT-1", "10001": "PLAT-1"}
        self.assertEqual(_pointer("PLAT-1", lookup), "PLAT-1")
        self.assertEqual(_pointer("10001", lookup), "PLAT-1")
        self.assertEqual(_pointer(10001, lookup), "PLAT-1")
        self.assertEqual(_pointer({"id": "10001", "key": "PLAT-1"}, lookup), "PLAT-1")
        self.assertEqual(_pointer({"data": {"key": "PLAT-1"}}, lookup), "PLAT-1")
        self.assertIsNone(_pointer({"showField": True}, lookup))
        self.assertIsNone(_pointer(None, lookup))
        self.assertIsNone(_pointer("OTHER-9", lookup))

    def test_text_values(self):
        self.assertEqual(text_values({"value": "PI 26.4", "id": "1"}), ["PI 26.4"])
        self.assertEqual(text_values([{"name": "v1"}, "v2", None]), ["v1", "v2"])
        self.assertEqual(text_values(" PI 1 "), ["PI 1"])
        self.assertEqual(text_values(None), [])

    def test_collect_links(self):
        room = {"walls": [{"id": "w", "panels": [
            {"id": "p1", "type": "progress", "data": {
                "items": [
                    {"id": "b1", "source": {"kind": "issue", "key": "PLAT-1"}},
                    {"id": "b2", "source": {"kind": "manual", "done": 1, "total": 2}},
                    {"id": "b3", "source": {"kind": "issue", "key": "plat-1"}},
                ],
                "auto": {"jql": "issuetype = Epic", "limit": 5}}},
            {"id": "p2", "type": "portfolio", "data": {"items": [
                {"id": "i1", "source": {"kind": "jql", "jql": "project = DATA"}},
                {"id": "i2", "source": None},
                {"id": "i3"},
            ]}},
            {"id": "p3", "type": "kpi", "data": {"items": [{"id": "k1", "source": {"kind": "issue", "key": "X-1"}}]}},
            "junk",
        ]}, "junk"]}
        links = collect_links(room)
        self.assertEqual(sorted(links.items), ["b1", "b3", "i1"])
        self.assertEqual(links.items["b1"], links.items["b3"])   # the same link is fetched once
        self.assertEqual(list(links.autos), ["p1"])
        self.assertEqual(len(links.specs), 3)
        self.assertEqual((links.boards, links.metrics), ({}, {}))
        self.assertEqual(collect_links(None).specs, {})
        self.assertEqual(collect_links({"walls": "nope"}).specs, {})

    def test_collect_boards_and_metrics(self):
        room = {"walls": [{"id": "w", "panels": [
            {"id": "k1", "type": "kanban", "data": {"columns": [], "cards": [], "jira": {"boardId": 7, "maxCards": 4}}},
            {"id": "k2", "type": "kanban", "data": {"columns": [], "cards": [], "jira": None}},
            {"id": "k3", "type": "kanban", "data": {"columns": [], "cards": [], "jira": {"boardId": 7, "maxCards": 9}}},
            {"id": "q1", "type": "kpi", "data": {"items": [
                {"id": "m1", "metric": {"kind": "cycle_time", "boardId": 7}},
                {"id": "m2", "metric": {"kind": "cycle_time", "boardId": None, "jql": ""}},   # no scope
                {"id": "m3", "metric": {"kind": "nonsense", "boardId": 7}},
                {"id": "m4"},
            ]}},
        ]}]}
        links = collect_links(room)
        self.assertEqual(sorted(links.boards), ["k1", "k3"])
        self.assertEqual(links.boards["k1"], links.boards["k3"])   # cards-per-column is display only
        self.assertEqual(list(links.metrics), ["m1"])
        self.assertEqual(len(links.specs), 2)

    def test_collect_burnups(self):
        room = {"walls": [{"id": "w", "panels": [
            {"id": "u1", "type": "burnup", "data": {"source": {"kind": "jql", "jql": "project = PLAT"},
                                                    "period": {"kind": "pi"}}},
            {"id": "u2", "type": "burnup", "data": {"source": None, "period": {"kind": "sprint"}}},   # not linked yet
            {"id": "u3", "type": "burnup", "data": {"source": {"kind": "manual", "done": 1, "total": 2}}},
            {"id": "p1", "type": "progress", "data": {"items": [
                {"id": "b1", "source": {"kind": "jql", "jql": "project = PLAT"}}]}},
        ]}]}
        links = collect_links(room)
        self.assertEqual(list(links.burnups), ["u1"])
        self.assertEqual(links.burn_periods, {"u1": {"kind": "pi"}})
        self.assertEqual(links.burnups["u1"], links.items["b1"])   # a chart and a bar on one link share it
        self.assertEqual(len(links.specs), 1)

    def test_period_range(self):
        current = {"pi": {"name": "PI 26.4", "start": "2026-10-05", "end": "2026-12-13"}, "sprint": None}
        self.assertEqual(period_range({"kind": "pi"}, current), (date(2026, 10, 5), date(2026, 12, 13)))
        self.assertIsNone(period_range({"kind": "sprint"}, current))             # no active sprint known
        self.assertEqual(period_range({"kind": "dates", "start": "2026-11-01", "end": "2026-11-30"}, current),
                         (date(2026, 11, 1), date(2026, 11, 30)))
        for bad in ({"kind": "dates", "start": "2026-11-30", "end": "2026-11-01"}, {"kind": "dates", "start": ""},
                    {"kind": "none"}, {}, None, "pi"):
            self.assertIsNone(period_range(bad, current), bad)


if __name__ == "__main__":
    unittest.main()
