"""Dependencies read from issue links: the wording rules on hand-built issues, then the
engine and the API against the fake Jira."""
import os
import threading
import unittest
from datetime import date

from fake_jira.data import status_json
from fake_jira.server import DEFAULT_TOKEN, make_fake_server, suggested_settings
from obeya.deps import dependencies, link_direction
from obeya.jira_client import JiraClient
from obeya.sources import Engine, normalize_deps, spec_id
from obeya.sync import collect_links
from tests.test_api import ApiCase, call, room

BLOCKS = {"name": "Blocks", "inward": "is blocked by", "outward": "blocks"}
DEPENDS = {"name": "Dependency", "inward": "is depended on by", "outward": "depends on"}
RELATES = {"name": "Relates", "inward": "relates to", "outward": "relates to"}
ODD = {"name": "Team handoff", "inward": "receives from", "outward": "hands to"}


def stub(key, status="To Do"):
    """A linked issue as Jira embeds it: a few fields only."""
    return {"key": key, "fields": {"summary": f"Summary of {key}", "status": status_json(status)}}


def issue(key, status="To Do", links=()):
    """links: (type, "inwardIssue" | "outwardIssue", other key, other status)."""
    return {"key": key, "fields": {
        "summary": f"Summary of {key}", "status": status_json(status),
        "issuelinks": [{"type": kind, slot: stub(other, other_status)} for kind, slot, other, other_status in links]}}


def pairs(found):
    return [(d["waiting"]["key"], d["on"]["key"], d["type"]) for d in found]


class Wording(unittest.TestCase):
    def test_direction_comes_from_the_words(self):
        for phrase in ("is blocked by", "depends on", "Depends upon", "is dependent on", "requires", "needs",
                       "is preceded by", "follows", "has to be done after", "waits for"):
            self.assertEqual(link_direction(phrase), "waits", phrase)
        for phrase in ("blocks", "is depended on by", "is required by", "is needed by", "precedes", "is followed by",
                       "has to be done before", "is a dependency of"):
            self.assertEqual(link_direction(phrase), "provides", phrase)
        for phrase in ("relates to", "duplicates", "is duplicated by", "clones", "is caused by", "", None):
            self.assertIsNone(link_direction(phrase), phrase)


class Reading(unittest.TestCase):
    def test_blocks_and_depends_put_the_other_issue_in_opposite_slots(self):
        found = dependencies([
            issue("A-1", "In Progress", [(BLOCKS, "inwardIssue", "B-1", "To Do")]),        # A-1 is blocked by B-1
            issue("A-2", "To Do", [(DEPENDS, "outwardIssue", "B-2", "In Progress")]),      # A-2 depends on B-2
            issue("A-3", "To Do", [(BLOCKS, "outwardIssue", "B-3", "To Do")]),             # A-3 blocks B-3
            issue("A-4", "Done", [(DEPENDS, "inwardIssue", "B-4", "To Do")]),              # A-4 is depended on by B-4
        ], "https://jira.example")
        self.assertCountEqual(pairs(found), [("A-1", "B-1", "Blocks"), ("A-2", "B-2", "Dependency"),
                                             ("B-3", "A-3", "Blocks"), ("B-4", "A-4", "Dependency")])

    def test_each_dependency_is_listed_once_though_jira_shows_it_on_both_issues(self):
        found = dependencies([
            issue("A-1", "In Progress", [(BLOCKS, "inwardIssue", "B-1", "To Do")]),
            issue("B-1", "To Do", [(BLOCKS, "outwardIssue", "A-1", "In Progress")]),
        ], "https://jira.example")
        self.assertEqual(pairs(found), [("A-1", "B-1", "Blocks")])
        dep = found[0]
        self.assertEqual(dep["waiting"], {"key": "A-1", "title": "Summary of A-1", "url": "https://jira.example/browse/A-1",
                                          "status": "In Progress", "category": "indeterminate", "project": "A"})
        self.assertEqual((dep["on"]["status"], dep["on"]["category"], dep["on"]["project"]), ("To Do", "new", "B"))

    def test_links_that_are_not_dependencies_are_left_out(self):
        found = dependencies([issue("A-1", links=[(RELATES, "inwardIssue", "B-1", "To Do"),
                                                  (ODD, "outwardIssue", "B-2", "To Do")]),
                              issue("A-2"), {"key": "A-3", "fields": {"issuelinks": ["junk", {"type": None}]}}],
                             "https://jira.example")
        self.assertEqual(found, [])

    def test_named_link_types_narrow_the_list_and_cover_wording_that_says_nothing(self):
        issues = [issue("A-1", links=[(BLOCKS, "inwardIssue", "B-1", "To Do"), (DEPENDS, "outwardIssue", "B-2", "To Do"),
                                      (ODD, "outwardIssue", "B-3", "To Do"), (ODD, "inwardIssue", "B-4", "To Do")])]
        self.assertEqual(pairs(dependencies(issues, "https://x", ["dependency"])), [("A-1", "B-2", "Dependency")])
        # A named type whose wording is unknown follows the "Blocks" convention: the inward issue is waited on.
        self.assertCountEqual(pairs(dependencies(issues, "https://x", ["Team handoff"])),
                              [("B-3", "A-1", "Team handoff"), ("A-1", "B-4", "Team handoff")])

    def test_order_puts_work_under_way_first_and_settled_dependencies_last(self):
        found = dependencies([
            issue("A-1", "To Do", [(BLOCKS, "inwardIssue", "A-9", "Done")]),            # settled
            issue("A-2", "To Do", [(BLOCKS, "inwardIssue", "A-8", "To Do")]),           # open, same project
            issue("A-3", "To Do", [(BLOCKS, "inwardIssue", "B-7", "To Do")]),           # open, across projects
            issue("A-4", "In Progress", [(BLOCKS, "inwardIssue", "A-6", "To Do")]),     # under way and waiting
            issue("A-5", "Done", [(BLOCKS, "inwardIssue", "A-7", "To Do")]),            # the waiting side is done: settled
        ], "https://x")
        self.assertEqual([d["waiting"]["key"] for d in found], ["A-4", "A-3", "A-2", "A-1", "A-5"])

    def test_summaries_can_be_kept_off_screens(self):
        found = dependencies([issue("A-1", links=[(BLOCKS, "inwardIssue", "B-1", "To Do")])], "https://x",
                             show_summaries=False)
        self.assertEqual((found[0]["waiting"]["title"], found[0]["on"]["title"]), ("A-1", "B-1"))


class Specs(unittest.TestCase):
    def test_normalize(self):
        self.assertEqual(normalize_deps({"jql": " project = PLAT ", "linkTypes": ["Blocks", " dependency ", ""],
                                         "limit": 5, "showDone": True}),
                         {"kind": "deps", "jql": "project = PLAT", "linkTypes": ["blocks", "dependency"]})
        for bad in (None, {}, {"jql": "  "}, "project = PLAT"):
            self.assertIsNone(normalize_deps(bad))
        # How many rows to show is a display setting: it does not make a new link.
        self.assertEqual(spec_id(normalize_deps({"jql": "project = PLAT", "limit": 5})),
                         spec_id(normalize_deps({"jql": "project = PLAT", "limit": 30, "showDone": True})))

    def test_collect_links(self):
        links = collect_links({"walls": [{"id": "w", "panels": [
            {"id": "d1", "type": "dependencies", "data": {"source": {"jql": "project = PLAT", "linkTypes": []}}},
            {"id": "d2", "type": "dependencies", "data": {"source": None}},
            {"id": "r1", "type": "risks", "data": {"items": [{"id": "x", "title": "A risk"}]}},
        ]}]})
        self.assertEqual(list(links.deps), ["d1"])
        self.assertEqual(len(links.specs), 1)


TODAY = date(2026, 11, 10)


class DepsEngine(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_fake_server(port=0, today=TODAY)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"
        cls.ds = cls.server.dataset
        cls.client = JiraClient(cls.url, DEFAULT_TOKEN)
        cls.settings = suggested_settings(cls.ds)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def compute(self, source, **jira):
        settings = {**self.settings, "jira": {**self.settings["jira"], **jira}}
        return Engine(self.client, settings, TODAY).compute(normalize_deps(source))

    def expected(self):
        """(waiting, on, type) straight from the dataset."""
        out = set()
        for i in self.ds.issues:
            out.update((i["key"], key, "Blocks") for key in i["blocked_by"])
            out.update((i["key"], key, name) for name, key in i["links"] if name == "Dependency")
        return out

    def test_finds_blocks_and_dependency_links_across_both_projects(self):
        r = self.compute({"jql": "project in (PLAT, DATA)"})
        self.assertTrue(r["ok"], r)
        self.assertEqual(set(pairs(r["deps"])), self.expected())
        self.assertEqual((len(r["deps"]), r["total"]), (3, 3))        # one Blocks, two Dependency; "Relates" is ignored
        self.assertEqual(r["scope"], len(self.ds.issues))
        by_type = {d["type"]: d for d in r["deps"] if d["type"] == "Blocks"}
        blocked = by_type["Blocks"]
        self.assertEqual((blocked["waiting"]["category"], blocked["on"]["category"]), ("indeterminate", "new"))
        self.assertEqual(r["deps"][0], blocked)                        # work under way that is waiting comes first
        self.assertEqual(blocked["waiting"]["url"], f"{self.url}/browse/{blocked['waiting']['key']}")
        self.assertEqual(blocked["waiting"]["title"], self.ds.by_key(blocked["waiting"]["key"])["summary"])
        across = [d for d in r["deps"] if d["waiting"]["project"] != d["on"]["project"]]
        self.assertEqual(len(across), 2)
        self.assertEqual(sum(1 for d in r["deps"] if d["on"]["category"] == "done"), 1)

    def test_a_dependency_shows_when_only_one_end_is_in_scope(self):
        whole = self.compute({"jql": "project in (PLAT, DATA)"})
        cross = next(d for d in whole["deps"] if d["waiting"]["project"] == "DATA")
        for project in ("DATA", "PLAT"):
            r = self.compute({"jql": f"project = {project}"})
            self.assertIn((cross["waiting"]["key"], cross["on"]["key"], "Dependency"), pairs(r["deps"]), project)
            # The end outside the query still carries its title and status, as Jira embeds them in the link.
            found = next(d for d in r["deps"] if d["waiting"]["key"] == cross["waiting"]["key"])
            self.assertEqual((found["on"]["title"], found["on"]["status"]), (cross["on"]["title"], cross["on"]["status"]))

    def test_link_types_pi_variables_and_privacy(self):
        only = self.compute({"jql": "project in (PLAT, DATA)", "linkTypes": ["blocks"]})
        self.assertEqual([d["type"] for d in only["deps"]], ["Blocks"])
        none = self.compute({"jql": 'issuetype = Epic AND {PI_FIELD} = "{PI}"'})
        self.assertEqual((none["ok"], none["deps"], none["scope"]), (True, [], 7))
        hidden = self.compute({"jql": "project = PLAT"}, showSummaries=False)
        self.assertTrue(all(d["waiting"]["title"] == d["waiting"]["key"] and d["on"]["title"] == d["on"]["key"]
                            for d in hidden["deps"]))

    def test_errors_are_reported_on_the_panel(self):
        bad = self.compute({"jql": "nosuchfield = 1"})
        self.assertEqual((bad["ok"], bad["deps"], bad["total"]), (False, [], 0))
        self.assertIn("nosuchfield", bad["error"])
        missing = self.compute({"jql": '{PI_FIELD} = "{PI}"'}, piField="")
        self.assertIn("Jira settings", missing["error"])

    def test_link_types_endpoint(self):
        self.assertEqual([t["name"] for t in self.client.link_types()], ["Blocks", "Dependency", "Relates"])


class DepsApi(ApiCase):
    def test_sync_preview_and_state(self):
        call(self.base, "PUT", "/api/settings", suggested_settings(self.fake.dataset))
        doc = room(
            {"id": "d1", "type": "dependencies", "title": "Dependencies", "span": 2,
             "data": {"source": {"jql": "project in (PLAT, DATA)", "linkTypes": [], "showDone": False, "limit": 12}}},
            {"id": "d2", "type": "dependencies", "title": "Not set up", "span": 1, "data": {"source": None}},
            {"id": "r1", "type": "risks", "title": "Risks", "span": 1,
             "data": {"items": [{"id": "x1", "title": "Hosting decision slips", "impact": "High", "roam": "Owned"}]}})
        self.assertEqual(self.save(doc, 0)[0], 200)
        self.assertEqual(self.state()["deps"], {})                       # nothing until a sync has run
        summary = self.syncer.run(full=True)
        self.assertEqual((summary["ok"], summary["sources"]), (True, 1))  # the risks panel is manual: nothing to fetch
        s = self.state()
        self.assertEqual(sorted(s["deps"]), ["d1"])
        self.assertEqual((s["deps"]["d1"]["ok"], s["deps"]["d1"]["total"]), (True, 3))
        self.assertEqual(s["room"]["walls"][0]["panels"][2]["data"]["items"][0]["roam"], "Owned")

        status, body, _ = call(self.base, "POST", "/api/jira/preview", {"deps": {"jql": "project = DATA"}})
        self.assertEqual((status, body["ok"]), (200, True))
        self.assertGreaterEqual(body["total"], 1)
        self.assertEqual(call(self.base, "POST", "/api/jira/preview", {"deps": {"jql": ""}})[0], 400)

    def test_empty_database_has_the_key(self):
        self.assertEqual(self.state()["deps"], {})


if os.environ.get("OBEYA_TEST_DATABASE_URL"):
    DepsApiPostgres = type("DepsApiPostgres", (DepsApi,), {"postgres": True})


if __name__ == "__main__":
    unittest.main()
