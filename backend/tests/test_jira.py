"""The Jira client and the progress engine, run against the fake Jira over real HTTP."""
import threading
import unittest
from datetime import date

from fake_jira.data import PI_FIELD, STORY_POINTS, Dataset
from fake_jira.jql import JqlError, search
from fake_jira.server import DEFAULT_TOKEN, make_fake_server, suggested_settings
from obeya.jira_client import JiraClient, JiraError, JiraUnavailable
from obeya.sources import Engine, normalize_auto, normalize_source

TODAY = date(2026, 11, 10)


def start_fake(**kwargs):
    server = make_fake_server(port=0, today=TODAY, **kwargs)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


class FakeJql(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ds = Dataset(TODAY)

    def keys(self, jql):
        return [i["key"] for i in search(self.ds, jql)]

    def test_key_and_lists(self):
        self.assertEqual(self.keys("key = PLAT-1"), ["PLAT-1"])
        self.assertEqual(self.keys("key in (plat-1, DATA-1)"), ["PLAT-1", "DATA-1"])

    def test_hierarchy_fields(self):
        epics = self.keys('"Parent Link" in (PLAT-1)')
        self.assertEqual(len(epics), 7)
        self.assertTrue(all(self.ds.by_key(k)["type"] == "Epic" for k in epics))
        stories = self.keys(f'"Epic Link" = {epics[0]}')
        self.assertEqual(len(stories), 9)
        self.assertEqual(len(self.keys(f"parent = {stories[0]}")), 2)

    def test_boolean_logic_and_order_by(self):
        both = self.keys('project = DATA AND issuetype = Epic ORDER BY created DESC')
        self.assertEqual(len(both), 3)
        either = self.keys('issuetype = Initiative OR (project = DATA AND issuetype = Epic)')
        self.assertEqual(len(either), 5)
        self.assertEqual(len(self.keys('issuetype in (Epic, Initiative) AND NOT project = DATA')), 8)
        self.assertEqual(len(self.keys("")), len(self.ds.issues))

    def test_pi_field_and_sprints(self):
        cur = self.ds.pis[1]["name"]
        self.assertEqual(cur, "PI 26.4")
        self.assertEqual(len(self.keys(f'issuetype = Epic AND cf[10500] = "{cur}"')), 7)
        self.assertEqual(self.keys('cf[10500] is EMPTY AND issuetype = Epic'), [])
        active = self.keys("sprint in openSprints()")
        self.assertTrue(active)
        self.assertTrue(all(self.ds.sprints[1]["id"] in self.ds.by_key(k)["sprints"] for k in active))

    def test_errors_look_like_jira(self):
        with self.assertRaisesRegex(JqlError, "does not exist"):
            search(self.ds, "nosuchfield = 1")
        with self.assertRaisesRegex(JqlError, "NOPE-1"):
            search(self.ds, "key = NOPE-1")
        with self.assertRaises(JqlError):
            search(self.ds, "project = ")


class EngineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server, cls.url = start_fake()
        cls.ds = cls.server.dataset
        cls.client = JiraClient(cls.url, DEFAULT_TOKEN)
        cls.settings = suggested_settings(cls.ds)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def engine(self, **jira):
        settings = {**self.settings, "jira": {**self.settings["jira"], **jira}}
        return Engine(self.client, settings, TODAY)

    def expected(self, epic_keys, measure="count"):
        """Work out the answer straight from the dataset."""
        stories = [i for i in self.ds.issues if i["type"] == "Story" and i["epic"] in epic_keys]
        empty = [self.ds.by_key(k) for k in epic_keys if not any(s["epic"] == k for s in stories)]
        items = stories + empty
        value = (lambda i: i["points"] or 0) if measure == "points" else (lambda i: 1)
        return (sum(value(i) for i in items), sum(value(i) for i in items if i["status"] == "Done"), len(items))

    def test_discovery(self):
        found = self.client.discovered_fields()
        self.assertEqual(found["epic_link"]["id"], "customfield_10101")
        self.assertEqual(found["parent_link"]["id"], "customfield_10102")
        self.assertEqual(found["story_points"]["id"], STORY_POINTS)
        self.assertFalse(self.client.is_cloud())

    def test_epic_counts_its_stories(self):
        r = self.engine().compute(normalize_source({"kind": "issue", "key": "PLAT-2"}))
        total, done, count = self.expected(["PLAT-2"])
        self.assertTrue(r["ok"], r)
        self.assertEqual((r["total"], r["done"], r["issues"]), (total, done, count))
        self.assertEqual(r["total"], r["done"] + r["inProgress"] + r["todo"])
        self.assertEqual((r["key"], r["title"], r["issueType"]), ("PLAT-2", "Proposal intake", "Epic"))
        self.assertEqual(r["url"], f"{self.url}/browse/PLAT-2")

    def test_initiative_walks_two_levels(self):
        epics = [i["key"] for i in self.ds.issues if i["parent_link"] == "PLAT-1"]
        r = self.engine().compute(normalize_source({"kind": "issue", "key": "plat-1"}))
        self.assertEqual((r["total"], r["done"], r["issues"]), self.expected(epics))
        # The epic with no stories counts as one open item, and epics with stories are not counted themselves.
        self.assertEqual(r["issues"], sum(1 for i in self.ds.issues if i["type"] == "Story" and i["epic"] in epics) + 1)

    def test_points(self):
        epics = [i["key"] for i in self.ds.issues if i["parent_link"] == "DATA-1"]
        r = self.engine().compute(normalize_source({"kind": "issue", "key": "DATA-1", "measure": "points"}))
        total, done, _ = self.expected(epics, "points")
        self.assertEqual((r["unit"], r["total"], r["done"]), ("points", total, done))
        stories = [i for i in self.ds.issues if i["type"] == "Story" and i["epic"] in epics]
        self.assertEqual(r["unestimated"], sum(1 for s in stories if s["points"] is None))
        self.assertGreater(r["unestimated"], 0)

    def test_subtasks_replace_their_story_only_when_asked(self):
        without = self.engine().compute(normalize_source({"kind": "issue", "key": "PLAT-2"}))
        with_subs = self.engine().compute(normalize_source({"kind": "issue", "key": "PLAT-2", "includeSubtasks": True}))
        # One story has two sub-tasks: it is replaced by them, so one more item.
        self.assertEqual(with_subs["issues"], without["issues"] + 1)

    def test_custom_done_statuses(self):
        epic = next(i["key"] for i in self.ds.issues if i["summary"] == "AI review service")
        r = self.engine().compute(normalize_source(
            {"kind": "issue", "key": epic, "doneStatuses": ["Done", "In Review"]}))
        stories = [i for i in self.ds.issues if i["epic"] == epic and i["type"] == "Story"]
        self.assertEqual(len(stories), 12)
        self.assertTrue(any(s["status"] == "In Review" for s in stories))
        self.assertEqual(r["done"], sum(1 for s in stories if s["status"] in ("Done", "In Review")))
        self.assertEqual(r["inProgress"], sum(1 for s in stories if s["status"] == "In Progress"))

    def test_issue_not_found(self):
        r = self.engine().compute(normalize_source({"kind": "issue", "key": "NOPE-1"}))
        self.assertFalse(r["ok"])
        self.assertIn("NOPE-1 was not found", r["error"])
        self.assertEqual(r["total"], 0)

    def test_jql_source_with_pi_variables(self):
        r = self.engine().compute(normalize_source({"kind": "jql", "jql": 'issuetype = Epic AND {PI_FIELD} = "{PI}"'}))
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["issues"], 7)
        self.assertNotIn("key", r)

    def test_jql_sprint_scope_excludes_subtasks(self):
        r = self.engine().compute(normalize_source({"kind": "jql", "jql": "sprint in openSprints()", "measure": "points"}))
        active = self.ds.sprints[1]["id"]
        stories = [i for i in self.ds.issues if active in i["sprints"]]
        self.assertEqual((r["issues"], r["total"]), (len(stories), sum(s["points"] or 0 for s in stories)))

    def test_bad_jql_is_reported_on_the_bar(self):
        r = self.engine().compute(normalize_source({"kind": "jql", "jql": "nosuchfield = 1"}))
        self.assertFalse(r["ok"])
        self.assertIn("nosuchfield", r["error"])

    def test_missing_pi_setup_is_reported(self):
        r = self.engine(piField="").compute(normalize_source({"kind": "jql", "jql": '{PI_FIELD} = "{PI}"'}))
        self.assertFalse(r["ok"])
        self.assertIn("Jira settings", r["error"])

    def test_auto_makes_one_bar_per_epic(self):
        r = self.engine().compute(normalize_auto({"jql": 'issuetype = Epic AND {PI_FIELD} = "{PI}"', "limit": 20}))
        self.assertTrue(r["ok"], r)
        self.assertFalse(r["truncated"])
        self.assertEqual(len(r["bars"]), 7)
        for bar in r["bars"]:
            self.assertEqual((bar["total"], bar["done"], bar["issues"]), self.expected([bar["key"]]), bar["key"])
        empty = next(b for b in r["bars"] if b["title"] == "Template library")
        self.assertEqual((empty["total"], empty["done"]), (1, 0))

    def test_auto_limit_truncates(self):
        r = self.engine().compute(normalize_auto({"jql": "issuetype = Epic", "limit": 3}))
        self.assertEqual((len(r["bars"]), r["truncated"]), (3, True))

    def test_auto_error(self):
        r = self.engine().compute(normalize_auto({"jql": "broken ==", "limit": 3}))
        self.assertEqual((r["ok"], r["bars"]), (False, []))

    def test_summaries_can_be_kept_off_screens(self):
        r = self.engine(showSummaries=False).compute(normalize_source({"kind": "issue", "key": "PLAT-2"}))
        self.assertEqual(r["title"], "PLAT-2")

    def test_batching_keeps_request_count_low(self):
        before = self.server.requests
        self.engine().compute(normalize_auto({"jql": "issuetype = Epic", "limit": 50}))
        # field list is cached; 1 search for the epics, then a few per level, not a few per epic.
        self.assertLess(self.server.requests - before, 12)


class OpaqueParentLink(unittest.TestCase):
    """Some Jira versions return a Parent Link value that does not name the parent."""

    def test_falls_back_to_one_parent_at_a_time(self):
        server, url = start_fake(parent_link_shape="opaque")
        try:
            ds = server.dataset
            engine = Engine(JiraClient(url, DEFAULT_TOKEN), suggested_settings(ds), TODAY)
            r = engine.compute(normalize_auto({"jql": "issuetype = Initiative", "limit": 10}))
            self.assertTrue(r["ok"], r)
            by_key = {b["key"]: b for b in r["bars"]}
            for root in ("PLAT-1", "DATA-1"):
                epics = [i["key"] for i in ds.issues if i["parent_link"] == root]
                stories = [i for i in ds.issues if i["type"] == "Story" and i["epic"] in epics]
                empties = sum(1 for e in epics if not any(s["epic"] == e for s in stories))
                self.assertEqual(by_key[root]["issues"], len(stories) + empties, root)
        finally:
            server.shutdown()
            server.server_close()


class ClientFailures(unittest.TestCase):
    def test_wrong_token_is_unavailable_not_a_bad_link(self):
        server, url = start_fake()
        try:
            client = JiraClient(url, "wrong")
            with self.assertRaisesRegex(JiraUnavailable, "401"):
                client.server_info()
        finally:
            server.shutdown()
            server.server_close()

    def test_unreachable(self):
        client = JiraClient("http://127.0.0.1:9", "x", timeout=2)
        with self.assertRaisesRegex(JiraUnavailable, "Could not reach Jira"):
            client.server_info()

    def test_bad_jql_is_a_plain_error(self):
        server, url = start_fake()
        try:
            client = JiraClient(url, DEFAULT_TOKEN)
            with self.assertRaises(JiraError) as ctx:
                client.search("nosuchfield = 1", ["summary"])
            self.assertNotIsInstance(ctx.exception, JiraUnavailable)
            self.assertEqual(ctx.exception.status, 400)
        finally:
            server.shutdown()
            server.server_close()

    def test_pagination(self):
        server, url = start_fake()
        try:
            client = JiraClient(url, DEFAULT_TOKEN)
            everything, truncated = client.search("", ["summary"])
            self.assertEqual((len(everything), truncated), (len(server.dataset.issues), False))
            self.assertEqual(len({i["key"] for i in everything}), len(everything))
            some, truncated = client.search("", ["summary"], limit=5)
            self.assertEqual((len(some), truncated), (5, True))
            self.assertEqual(client.active_sprint(1)["name"], server.dataset.sprints[1]["name"])
            self.assertEqual(len(client.boards()), 2)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
