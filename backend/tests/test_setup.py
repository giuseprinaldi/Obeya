"""The setup and verify commands, run against the fake Jira and a real SQLite database."""
import copy
import json
import os
import shutil
import tempfile
import threading
import unittest
from dataclasses import replace
from pathlib import Path

from fake_jira.server import DEFAULT_TOKEN, make_fake_server
from obeya import roomsetup, verify
from obeya.config import BACKEND_DIR, load_config
from obeya.db import Database
from obeya.roomsetup import SetupError, read_plan
from obeya.sync import Syncer, collect_links

EXAMPLE = BACKEND_DIR / "setup.example.json"
FIXTURE = Path(__file__).parent / "fixtures" / "setup-room.json"


def example() -> dict:
    return json.loads(EXAMPLE.read_text(encoding="utf-8"))


class SetupCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="obeya-setup-")
        cls.db = Database(os.path.join(cls.tmp, "obeya.db"))
        cls.db.init_schema()
        cls.fake = make_fake_server(port=0)
        threading.Thread(target=cls.fake.serve_forever, daemon=True).start()
        cls.cfg = replace(load_config(), sync_seconds=3600, jira_auth="bearer", jira_token=DEFAULT_TOKEN,
                          jira_base_url=f"http://127.0.0.1:{cls.fake.server_address[1]}")
        cls.syncer = Syncer(cls.db, cls.cfg)

    @classmethod
    def tearDownClass(cls):
        cls.fake.shutdown()
        cls.fake.server_close()
        cls.db.destroy()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        with self.db.connect() as conn:
            for table in ("room", "room_history", "settings", "progress_cache", "progress_history", "kv", "sync_run"):
                conn.execute(f"DELETE FROM {table}")

    def write(self, plan) -> str:
        path = os.path.join(self.tmp, "setup.json")
        Path(path).write_text(plan if isinstance(plan, str) else json.dumps(plan), encoding="utf-8")
        return path

    def run_setup(self, plan=None, **kwargs):
        return roomsetup.run(self.db, self.syncer, self.write(plan if plan is not None else example()), **kwargs)

    def walls(self):
        return [w["id"] for w in self.db.get_room()["doc"]["walls"]]


class Setup(SetupCase):
    def test_the_example_file_builds_a_room_where_every_link_works(self):
        code, text = self.run_setup()
        self.assertEqual(code, 0, text)
        self.assertIn("20 links, none failed.", text)
        self.assertNotIn("[FAIL]", text)
        self.assertNotIn("[EMPTY]", text)
        row = self.db.get_room()
        self.assertEqual(row["version"], 1)        # created without a browser having opened the app
        self.assertEqual(row["doc"]["roomName"], "Example program")
        self.assertEqual(self.walls(), ["setup-team-platform", "setup-team-data", "setup-portfolio", "setup-dependencies"])
        settings = self.db.get_settings()
        self.assertEqual((settings["jira"]["notCounted"], settings["jira"]["boardId"]), (["Cancelled"], 1))
        # A scrum team gets sprint figures and a burn-up; a kanban team gets neither.
        kinds = lambda wall: [p["type"] for p in row["doc"]["walls"][wall]["panels"]]     # noqa: E731
        self.assertEqual(kinds(0), ["kpi", "burnup", "kpi", "kanban"])
        self.assertEqual(kinds(1), ["kpi", "kpi", "kanban"])
        # The team that estimates in hours is measured in its own field, and says so on the wall.
        wip = next(i for i in row["doc"]["walls"][1]["panels"][0]["data"]["items"] if i["metric"]["kind"] == "wip")
        self.assertEqual((wip["unit"], wip["metric"]["estimateField"]), ("hrs", "customfield_10108"))
        self.assertIn("Data / Right now / Work in progress: 40 hrs", text)

    def test_running_it_again_changes_nothing(self):
        self.run_setup()
        sids = set(collect_links(self.db.get_room()["doc"]).specs)
        code, text = self.run_setup()
        self.assertEqual(code, 0, text)
        self.assertIn("Settings: already as the file says.", text)
        self.assertIn("Room: already as the file says.", text)
        self.assertEqual(self.db.get_room()["version"], 1)
        self.assertEqual(set(collect_links(self.db.get_room()["doc"]).specs), sids)

    def test_a_changed_file_updates_its_own_walls_in_place(self):
        self.run_setup()
        plan = example()
        plan["teams"] = [plan["teams"][1], {"name": "Platform", "boardId": 1, "scope": "project = PLAT"}]
        del plan["portfolio"]
        code, text = self.run_setup(plan)
        self.assertEqual(code, 0, text)
        # Walls keep the place they had, a wall that is no longer in the file goes, and the version moves on.
        self.assertEqual(self.walls(), ["setup-team-platform", "setup-team-data", "setup-dependencies"])
        self.assertEqual(self.db.get_room()["version"], 2)
        self.assertEqual(len(self.db.room_versions()), 2)      # the earlier room can still be restored

    def test_a_dry_run_tries_every_link_and_writes_nothing(self):
        code, text = self.run_setup(dry_run=True)
        self.assertEqual(code, 0, text)
        self.assertIn("Dry run: nothing is written.", text)
        self.assertIn("20 links, none failed.", text)
        self.assertIsNone(self.db.get_room())
        self.assertEqual(self.db.get_settings()["jira"]["piField"], "")
        self.assertEqual(self.db.cached_results(), {})
        plan = example()
        plan["teams"][0]["scope"] = "nosuchfield = 1"
        plan["counts"].append({"name": "Nothing", "jql": "project = PLAT AND status = Cancelled"})
        code, text = self.run_setup(plan, dry_run=True)
        self.assertEqual(code, 1)
        self.assertIn("[FAIL] Platform / Sprint burn-up:", text)
        self.assertIn("nosuchfield", text)
        self.assertIn("21 links, 1 failed.", text)

    def test_walls_made_by_hand_are_kept_unless_the_room_is_replaced(self):
        mine = {"id": "w-mine", "name": "Direction", "subtitle": "", "panels": [
            {"id": "p1", "type": "statement", "title": "True north", "span": 3, "data": {"text": "Ours", "meta": ""}},
            {"id": "p2", "type": "progress", "title": "Old links", "span": 3, "data": {"items": [
                {"id": "b1", "label": "", "owner": "", "note": "", "source": {"kind": "issue", "key": "NOPE-1"}}], "auto": None}}]}
        stale = {"id": "setup-team-gone", "name": "Gone", "subtitle": "", "panels": []}
        self.db.save_room({"v": 2, "roomName": "Ours", "theme": "dark", "example": True, "walls": [mine, stale]}, 0)
        code, text = self.run_setup()
        # The hand-made wall stays first, with its broken link reported; the stale generated wall goes.
        self.assertEqual(self.walls()[0], "w-mine")
        self.assertNotIn("setup-team-gone", self.walls())
        self.assertEqual(len(self.walls()), 5)
        self.assertEqual(code, 1)
        self.assertIn("[FAIL] Direction / Old links / NOPE-1: NOPE-1 was not found", text)
        self.assertIn("Walls this command did not create were kept: Direction.", text)
        doc = self.db.get_room()["doc"]
        self.assertEqual((doc["theme"], doc["roomName"], doc["example"]), ("dark", "Example program", True))
        code, text = self.run_setup({**example(), "replaceRoom": True})
        self.assertEqual(code, 0, text)
        self.assertEqual(self.walls(), ["setup-team-platform", "setup-team-data", "setup-portfolio", "setup-dependencies"])
        doc = self.db.get_room()["doc"]
        self.assertEqual((doc["theme"], doc["example"]), ("dark", False))
        self.assertEqual(len(self.db.room_versions()), 3)      # nothing is lost: every earlier room is kept

    def test_only_the_settings_the_file_names_are_changed(self):
        pis = [{"name": "PI 26.4", "start": "2026-10-01", "end": "2026-12-31"}]
        self.db.save_settings({"jira": {"piField": "customfield_10500", "boardId": 1, "showAssignees": False}, "pis": pis})
        code, text = self.run_setup({"version": 1, "settings": {"jira": {"notCounted": ["Cancelled"]}}})
        self.assertEqual(code, 0, text)
        self.assertIn("Settings: saved (notCounted).", text)
        self.assertIn("Room: there is none", text)
        after = self.db.get_settings()
        self.assertEqual(after["pis"], pis)
        self.assertEqual((after["jira"]["piField"], after["jira"]["boardId"], after["jira"]["showAssignees"]),
                         ("customfield_10500", 1, False))
        self.assertEqual(after["jira"]["notCounted"], ["Cancelled"])

    def test_notes_say_what_was_left_out_and_why(self):
        plan = example()
        plan["settings"]["jira"].update(boardId=None, blocked={"flagged": False, "statuses": [], "labels": [], "links": True})
        plan["portfolio"] = {"boardId": 2, "hiddenColumns": ["Backlog"]}
        code, text = self.run_setup(plan)
        self.assertEqual(code, 0, text)
        self.assertIn("No board is chosen for the current sprint", text)
        self.assertIn("\"Blocked days\" was left off the team walls", text)
        self.assertIn("The portfolio wall has no bars yet", text)
        self.assertNotIn("Blocked days:", text)
        self.assertIn("[PASS] Portfolio / Portfolio board: Data board:", text)
        self.assertIn("(Doing ", text)      # the hidden Backlog column is not listed

    def test_a_file_that_cannot_be_used_changes_nothing(self):
        def refused(plan, *expect):
            code, text = self.run_setup(plan)
            self.assertEqual(code, 2, text)
            self.assertTrue(text.startswith("Nothing was changed."), text)
            for part in expect:
                self.assertIn(part, text)
            self.assertIsNone(self.db.get_room())
            self.assertEqual(self.db.get_settings()["jira"]["piField"], "")

        refused("{not json", "is not valid JSON")
        refused({**example(), "version": 2}, "\"version\" must be 1")
        refused({**example(), "team": []}, "unknown key team")
        plan = example()
        plan["teams"][0]["boardId"] = 99
        refused(plan, "teams: \"Platform\": board 99 cannot be read in Jira")
        plan = example()
        plan["teams"][0]["jql"] = plan["teams"][0].pop("scope")
        refused(plan, "teams[0]: unknown key jql")
        plan = example()
        plan["teams"][1]["measure"] = "count"
        refused(plan, "teams[1].estimateField only applies with \"measure\": \"points\"")
        plan = example()
        plan["teams"].append(dict(plan["teams"][0], name="platform"))
        refused(plan, "there is already a team called \"platform\"")
        plan = example()
        plan["portfolio"]["items"] = ["PLAT-1", "not a key"]
        refused(plan, "\"not a key\" is not a Jira key")
        plan = example()
        plan["settings"]["jira"]["token"] = "secret"
        refused(plan, "settings.jira: unknown key token")
        code, text = roomsetup.run(self.db, self.syncer, os.path.join(self.tmp, "missing.json"))
        self.assertEqual(code, 2)
        self.assertIn("Could not read", text)
        with self.assertRaisesRegex(SetupError, "names no settings"):
            read_plan({"version": 1})

    def test_without_jira_nothing_is_written(self):
        syncer = Syncer(self.db, replace(self.cfg, jira_base_url="", jira_token=""))
        code, text = roomsetup.run(self.db, syncer, self.write(example()))
        self.assertEqual(code, 2)
        self.assertIn("Jira is not connected", text)
        self.assertIsNone(self.db.get_room())
        self.assertEqual(verify.run(self.db, syncer)[0], 1)

    def test_the_built_room_matches_the_fixture_the_frontend_tests_read(self):
        # frontend/src/logic/setup.test.ts checks that the app keeps every link in this room as it is.
        self.run_setup()
        built = json.dumps(self.db.get_room()["doc"], indent=1, sort_keys=True) + "\n"
        if os.environ.get("OBEYA_WRITE_FIXTURES"):
            FIXTURE.parent.mkdir(exist_ok=True)
            FIXTURE.write_text(built, encoding="utf-8", newline="\n")
        self.assertEqual(built, FIXTURE.read_text(encoding="utf-8"),
                         "The room built from setup.example.json has changed. If that is intended, run this test "
                         "once with OBEYA_WRITE_FIXTURES=1 and commit the fixture.")


class Verify(SetupCase):
    def room(self, *items):
        return {"v": 2, "roomName": "Room", "walls": [{"id": "w", "name": "Delivery", "subtitle": "", "panels": [
            {"id": "p", "type": "progress", "title": "Bars", "span": 3, "data": {"items": list(items), "auto": None}}]}]}

    def bar(self, bar_id, source, label=""):
        return {"id": bar_id, "label": label, "owner": "", "note": "", "source": source}

    def test_no_room_and_no_links(self):
        code, text = verify.run(self.db, self.syncer)
        self.assertEqual(code, 1)
        self.assertIn("There is no room yet", text)
        self.db.save_room(self.room(self.bar("m", {"kind": "manual", "done": 1, "total": 2, "unit": "x"})), 0)
        code, text = verify.run(self.db, self.syncer)
        self.assertEqual(code, 0)
        self.assertIn("The room has no Jira links.", text)

    def test_every_link_gets_a_line_and_a_failure_sets_the_exit_code(self):
        self.db.save_room(self.room(
            self.bar("a", {"kind": "issue", "key": "PLAT-2", "measure": "points"}),
            self.bar("b", {"kind": "issue", "key": "NOPE-1"}, "Renamed"),
            self.bar("c", {"kind": "jql", "jql": "project = PLAT AND status = Cancelled"}, "Nothing here")), 0)
        code, text = verify.run(self.db, self.syncer)
        self.assertEqual(code, 1)
        lines = text.splitlines()
        self.assertTrue(any(l.startswith("[PASS] Delivery / Bars / PLAT-2: ") and "points done" in l for l in lines), text)
        self.assertIn("[FAIL] Delivery / Bars / Renamed: NOPE-1 was not found in Jira, or the Jira account cannot see it.", lines)
        self.assertIn("[EMPTY] Delivery / Bars / Nothing here: no issues in scope", lines)
        self.assertIn("3 links, 1 failed.", lines)
        self.assertIn("1 is empty: Jira answered, but nothing is in scope. "
                      "Check that each points at the right board, team or query.", lines)

    def test_an_empty_link_is_reported_but_does_not_fail(self):
        self.db.save_room(self.room(self.bar("c", {"kind": "jql", "jql": "project = PLAT AND status = Cancelled"})), 0)
        code, text = verify.run(self.db, self.syncer)
        self.assertEqual(code, 0)
        self.assertIn("1 links, none failed.", text)
        self.assertIn("[EMPTY]", text)

    def test_a_sync_that_cannot_reach_jira_is_a_failure(self):
        self.db.save_room(self.room(self.bar("a", {"kind": "issue", "key": "PLAT-2"})), 0)
        syncer = Syncer(self.db, replace(self.cfg, jira_token="wrong"))
        with self.assertLogs("obeya.sync", level="WARNING"):
            code, text = verify.run(self.db, syncer)
        self.assertEqual(code, 1)
        self.assertIn("The sync stopped:", text)


class Plans(unittest.TestCase):
    def test_defaults_and_ids(self):
        plan = read_plan({"version": 1, "teams": [{"name": " Team A/B ", "boardId": 3, "scope": " project = X "}]})
        self.assertEqual(plan["teams"], [{"name": "Team A/B", "boardId": 3, "scope": "project = X", "boardQuery": "",
                                          "measure": "count"}])
        wall = roomsetup.build_walls(plan, {3: "kanban"}, {})[0]
        self.assertEqual((wall["id"], wall["name"]), ("setup-team-team-a-b", "Team A/B"))
        ids = [p["id"] for p in wall["panels"]] + [i["id"] for p in wall["panels"] for i in p["data"].get("items", [])]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertTrue(all(i.startswith("setup-team-team-a-b-") for i in ids))

    def test_done_statuses_from_the_file_go_on_every_link(self):
        plan = read_plan({**example(), "doneStatuses": ["Done", "Closed"]})
        walls = roomsetup.build_walls(plan, {1: "scrum", 2: "kanban"}, {})
        specs = collect_links({"walls": walls}).specs.values()
        with_done = [s for s in specs if s["kind"] in ("issue", "jql", "metric") and s.get("metric") != "count"]
        self.assertGreater(len(with_done), 10)
        self.assertTrue(all(s["doneStatuses"] == ["Closed", "Done"] for s in with_done))

    def test_merging_is_stable(self):
        plan = read_plan(example())
        walls = roomsetup.build_walls(plan, {1: "scrum", 2: "kanban"}, {})
        once = roomsetup.merge_room(None, walls, plan)
        self.assertEqual(roomsetup.merge_room(copy.deepcopy(once), walls, plan), once)


if __name__ == "__main__":
    unittest.main()
