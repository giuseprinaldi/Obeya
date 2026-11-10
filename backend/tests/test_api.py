"""The HTTP API end to end: a real database, real HTTP and the fake Jira.

Always runs on a throwaway SQLite file. Set OBEYA_TEST_DATABASE_URL to a
postgresql:// URL to run every test a second time on Postgres."""
import json
import os
import shutil
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import uuid
from dataclasses import replace
from datetime import date

from fake_jira.server import DEFAULT_TOKEN, make_fake_server, suggested_settings
from obeya.config import load_config
from obeya.db import Database
from obeya.server import App, make_server
from obeya.sync import Syncer


def call(base, method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            text = resp.read().decode()
            return resp.status, (json.loads(text) if text else None), resp.headers
    except urllib.error.HTTPError as err:
        text = err.read().decode()
        return err.code, (json.loads(text) if text else None), err.headers


def room(*panels):
    return {"v": 2, "roomName": "Test room", "theme": "auto", "tvTheme": "dark", "accent": "cobalt",
            "density": "comfortable", "rotate": 0, "example": False,
            "walls": [{"id": "w1", "name": "Wall", "subtitle": "", "panels": list(panels)}]}


def progress_panel(items, auto=None):
    return {"id": "p1", "type": "progress", "title": "Progress", "span": 3,
            "data": {"items": items, "auto": auto, "sort": "manual", "showKeys": True}}


class ApiCase(unittest.TestCase):
    jira = True
    postgres = False

    @classmethod
    def setUpClass(cls):
        cfg = load_config()
        cls.tmp = tempfile.mkdtemp(prefix="obeya-test-")
        if cls.postgres:
            cls.db = Database(os.environ["OBEYA_TEST_DATABASE_URL"], schema="test_" + uuid.uuid4().hex[:12])
        else:
            cls.db = Database(os.path.join(cls.tmp, "obeya.db"))
        cls.db.init_schema()
        cls.fake = make_fake_server(port=0)
        threading.Thread(target=cls.fake.serve_forever, daemon=True).start()
        cls.cfg = replace(
            cfg, host="127.0.0.1", port=0, sync_seconds=3600, jira_auth="bearer",
            jira_base_url=f"http://127.0.0.1:{cls.fake.server_address[1]}" if cls.jira else "",
            jira_token=DEFAULT_TOKEN if cls.jira else "")
        cls.syncer = Syncer(cls.db, cls.cfg)   # not started: tests trigger runs themselves
        cls.server = make_server(App(cls.cfg, cls.db, cls.syncer))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.fake.shutdown()
        cls.fake.server_close()
        cls.db.destroy()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        with self.db.connect() as conn:
            for table in ("room", "room_history", "settings", "progress_cache", "progress_history", "kv", "sync_run"):
                conn.execute(f"DELETE FROM {table}")

    def save(self, doc, base_version):
        return call(self.base, "PUT", "/api/room", {"room": doc, "baseVersion": base_version})

    def state(self):
        status, body, _ = call(self.base, "GET", "/api/state")
        self.assertEqual(status, 200)
        return body


class RoomApi(ApiCase):
    def test_empty_database(self):
        s = self.state()
        self.assertIsNone(s["room"])
        self.assertEqual((s["version"], s["updatedAt"], s["progress"], s["auto"]), (0, None, {}, {}))
        self.assertEqual(s["periods"]["today"], date.today().isoformat())
        self.assertEqual((s["periods"]["pi"], s["periods"]["sprint"]), (None, None))
        self.assertTrue(s["sync"]["jiraConfigured"])

    def test_first_save_then_edit(self):
        status, body, _ = self.save(room(), 0)
        self.assertEqual((status, body["version"]), (200, 1))
        doc = room()
        doc["roomName"] = "Renamed"
        status, body, _ = self.save(doc, 1)
        self.assertEqual((status, body["version"]), (200, 2))
        s = self.state()
        self.assertEqual((s["room"]["roomName"], s["version"]), ("Renamed", 2))
        self.assertIsNotNone(s["updatedAt"])

    def test_conflicts_return_the_current_room(self):
        self.save(room(), 0)
        winner = room()
        winner["roomName"] = "Winner"
        self.assertEqual(self.save(winner, 1)[0], 200)
        loser = room()
        loser["roomName"] = "Loser"
        status, body, _ = self.save(loser, 1)
        self.assertEqual((status, body["error"], body["version"]), (409, "conflict", 2))
        self.assertEqual(body["room"]["roomName"], "Winner")
        # A second "first save" must not overwrite an existing room either.
        self.assertEqual(self.save(loser, 0)[0], 409)
        self.assertEqual(self.state()["room"]["roomName"], "Winner")

    def test_rejects_things_that_are_not_rooms(self):
        for bad in ({"walls": "x"}, {"walls": [{"id": "w"}]}, {"walls": [{"id": "w", "panels": [{"id": "p"}]}]}, [], None):
            status, body, _ = self.save(bad, 0)
            self.assertEqual(status, 400, bad)
            self.assertIn("error", body)
        self.assertEqual(call(self.base, "PUT", "/api/room", {"room": room(), "baseVersion": "1"})[0], 400)
        self.assertIsNone(self.state()["room"])

    def test_bad_json_unknown_routes_and_methods(self):
        req = urllib.request.Request(self.base + "/api/room", data=b"{nope", method="PUT")
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req, timeout=10)
        self.assertEqual(ctx.exception.code, 400)
        self.assertEqual(call(self.base, "GET", "/api/nope")[0], 404)
        self.assertEqual(call(self.base, "POST", "/api/state", {})[0], 404)
        self.assertEqual(call(self.base, "GET", "/api/health")[1], {"ok": True})

    def test_etag_revalidation(self):
        self.save(room(), 0)
        _, _, headers = call(self.base, "GET", "/api/state")
        etag = headers["ETag"]
        self.assertTrue(etag)
        status, _, _ = call(self.base, "GET", "/api/state", headers={"If-None-Match": etag})
        self.assertEqual(status, 304)

    def test_room_history_is_kept(self):
        self.save(room(), 0)
        self.save(room(), 1)
        with self.db.connect() as conn:
            versions = [r["version"] for r in conn.execute("SELECT version FROM room_history ORDER BY version").fetchall()]
        self.assertEqual(versions, [1, 2])


class SettingsApi(ApiCase):
    def test_defaults_then_save_cleans_input(self):
        _, body, _ = call(self.base, "GET", "/api/settings")
        self.assertEqual(body, {"jira": {"piField": "", "storyPointsField": "", "boardId": None, "showSummaries": True}, "pis": []})
        status, body, _ = call(self.base, "PUT", "/api/settings", {
            "jira": {"piField": " customfield_10500 ", "boardId": "7", "showSummaries": False, "token": "secret"},
            "pis": [{"name": "B", "start": "2027-01-01", "end": "2027-03-31"},
                    {"name": "A", "start": "2026-10-01", "end": "2026-12-31"},
                    {"name": "Bad", "start": "nope", "end": "2026-12-31"}],
            "extra": 1})
        self.assertEqual(status, 200)
        self.assertEqual(body["jira"], {"piField": "customfield_10500", "storyPointsField": "", "boardId": None, "showSummaries": False})
        self.assertEqual([p["name"] for p in body["pis"]], ["A", "B"])
        self.assertEqual(call(self.base, "GET", "/api/settings")[1], body)
        self.assertEqual(call(self.base, "PUT", "/api/settings", [])[0], 400)

    def test_periods_follow_the_calendar(self):
        call(self.base, "PUT", "/api/settings", suggested_settings(self.fake.dataset))
        self.syncer.run(full=True)
        periods = self.state()["periods"]
        self.assertEqual(periods["pi"]["name"], self.fake.dataset.pis[1]["name"])
        self.assertEqual(periods["nextPi"]["name"], self.fake.dataset.pis[2]["name"])
        self.assertEqual(periods["sprint"]["name"], self.fake.dataset.sprints[1]["name"])
        self.assertLessEqual(periods["sprint"]["start"], periods["today"])
        self.assertGreaterEqual(periods["sprint"]["end"], periods["today"])


class JiraApi(ApiCase):
    def configure(self):
        call(self.base, "PUT", "/api/settings", suggested_settings(self.fake.dataset))

    def test_status_fields_boards(self):
        _, status, _ = call(self.base, "GET", "/api/jira/status")
        self.assertEqual((status["configured"], status["ok"], status["deployment"], status["version"], status["error"]),
                         (True, True, "Server", "9.12.4", None))
        _, fields, _ = call(self.base, "GET", "/api/jira/fields")
        self.assertIn({"id": "customfield_10500", "name": "Program Increment", "custom": True}, fields)
        _, boards, _ = call(self.base, "GET", "/api/jira/boards")
        self.assertEqual([b["id"] for b in boards], [2, 1])   # sorted by name

    def test_pi_values_need_a_field_then_list_what_jira_uses(self):
        self.assertEqual(call(self.base, "GET", "/api/jira/pi-values")[1], [])
        self.configure()
        self.assertEqual(call(self.base, "GET", "/api/jira/pi-values")[1],
                         sorted((p["name"] for p in self.fake.dataset.pis), reverse=True))

    def test_preview(self):
        self.configure()
        status, body, _ = call(self.base, "POST", "/api/jira/preview", {"source": {"kind": "issue", "key": "https://x/browse/PLAT-1"}})
        self.assertEqual((status, body["ok"], body["key"], body["issueType"]), (200, True, "PLAT-1", "Initiative"))
        status, body, _ = call(self.base, "POST", "/api/jira/preview", {"source": {"kind": "issue", "key": "NOPE-9"}})
        self.assertEqual((status, body["ok"]), (200, False))
        status, body, _ = call(self.base, "POST", "/api/jira/preview", {"auto": {"jql": "issuetype = Epic", "limit": 4}})
        self.assertEqual((status, len(body["bars"]), body["truncated"]), (200, 4, True))
        self.assertEqual(call(self.base, "POST", "/api/jira/preview", {"source": {"kind": "issue", "key": ""}})[0], 400)
        self.assertEqual(call(self.base, "POST", "/api/jira/preview", {})[0], 400)

    def test_sync_fills_in_bars_portfolio_items_and_auto_panels(self):
        self.configure()
        doc = room(
            progress_panel(
                [{"id": "b1", "label": "", "source": {"kind": "issue", "key": "PLAT-1", "measure": "count"}},
                 {"id": "b2", "label": "Manual", "source": {"kind": "manual", "done": 3, "total": 10, "unit": "tasks"}},
                 {"id": "b3", "label": "Broken", "source": {"kind": "issue", "key": "NOPE-1"}},
                 {"id": "b4", "label": "Same link again", "source": {"kind": "issue", "key": "plat-1"}}],
                auto={"jql": 'issuetype = Epic AND {PI_FIELD} = "{PI}"', "limit": 12, "measure": "count"}),
            {"id": "p2", "type": "portfolio", "title": "Portfolio", "span": 3, "data": {"items": [
                {"id": "i1", "name": "Data", "source": {"kind": "issue", "key": "DATA-1", "measure": "points"}},
                {"id": "i2", "name": "Unlinked", "progress": 40}]}})
        self.assertEqual(self.save(doc, 0)[0], 200)
        self.assertEqual(self.state()["progress"], {})          # nothing until a sync has run

        status, summary, _ = call(self.base, "POST", "/api/sync", {})
        self.assertEqual((status, summary["ok"], summary["error"], summary["sources"]), (200, True, None, 4))

        s = self.state()
        self.assertEqual(sorted(s["progress"]), ["b1", "b3", "b4", "i1"])
        b1 = s["progress"]["b1"]
        self.assertTrue(b1["ok"])
        self.assertEqual((b1["key"], b1["title"], b1["unit"]), ("PLAT-1", "Feature proposal pipeline", "issues"))
        self.assertGreater(b1["total"], b1["done"])
        self.assertEqual(b1["history"], [{"d": date.today().isoformat(), "done": b1["done"], "total": b1["total"]}])
        self.assertEqual(s["progress"]["b4"]["total"], b1["total"])
        self.assertFalse(s["progress"]["b3"]["ok"])
        self.assertIn("NOPE-1", s["progress"]["b3"]["error"])
        self.assertEqual(s["progress"]["i1"]["unit"], "points")
        auto = s["auto"]["p1"]
        self.assertEqual((auto["ok"], len(auto["bars"]), auto["truncated"]), (True, 7, False))
        self.assertEqual(len(auto["bars"][0]["history"]), 1)
        self.assertEqual((s["sync"]["lastOk"], s["sync"]["lastError"]), (True, None))
        self.assertIsNotNone(s["sync"]["lastRunAt"])

    def test_a_second_sync_the_same_day_updates_instead_of_duplicating(self):
        self.configure()
        self.save(room(progress_panel([{"id": "b1", "source": {"kind": "issue", "key": "PLAT-2"}}])), 0)
        self.syncer.run(full=True)
        self.syncer.run(full=True)
        self.assertEqual(len(self.state()["progress"]["b1"]["history"]), 1)

    def test_partial_sync_only_fetches_new_links_and_full_sync_prunes(self):
        self.configure()
        self.save(room(progress_panel([{"id": "b1", "source": {"kind": "issue", "key": "PLAT-2"}}])), 0)
        self.assertEqual(self.syncer.run(full=True)["sources"], 1)
        self.save(room(progress_panel([{"id": "b1", "source": {"kind": "issue", "key": "PLAT-2"}},
                                       {"id": "b2", "source": {"kind": "issue", "key": "DATA-2"}}])), 1)
        self.assertEqual(self.syncer.run(full=False)["sources"], 1)
        self.assertEqual(sorted(self.state()["progress"]), ["b1", "b2"])
        self.assertEqual(self.syncer.run(full=False)["sources"], 0)
        # Remove a link: the next full run drops its cached result.
        self.save(room(progress_panel([{"id": "b2", "source": {"kind": "issue", "key": "DATA-2"}}])), 2)
        self.syncer.run(full=True)
        self.assertEqual(len(self.db.cached_results()), 1)

    def test_jira_outage_keeps_the_last_good_numbers(self):
        self.configure()
        self.save(room(progress_panel([{"id": "b1", "source": {"kind": "issue", "key": "PLAT-2"}}])), 0)
        self.syncer.run(full=True)
        good = self.state()["progress"]["b1"]
        broken = Syncer(self.db, replace(self.cfg, jira_token="wrong"))
        result = broken.run(full=True)
        self.assertFalse(result["ok"])
        self.assertIn("401", result["error"])
        s = self.state()
        self.assertEqual(s["progress"]["b1"]["done"], good["done"])
        self.assertTrue(s["progress"]["b1"]["ok"])
        self.assertEqual(s["sync"]["lastOk"], False)
        self.assertIn("401", s["sync"]["lastError"])

    def test_changing_the_calendar_moves_the_pi_bars(self):
        self.configure()
        auto = {"jql": 'issuetype = Epic AND {PI_FIELD} = "{PI}"', "limit": 20}
        self.save(room(progress_panel([], auto=auto)), 0)
        self.syncer.run(full=True)
        self.assertEqual(len(self.state()["auto"]["p1"]["bars"]), 7)
        # Pretend the next PI has started: only the calendar changes, not the room.
        settings = suggested_settings(self.fake.dataset)
        nxt = settings["pis"][2]
        settings["pis"] = [{"name": nxt["name"], "start": "2000-01-01", "end": "2999-12-31"}]
        call(self.base, "PUT", "/api/settings", settings)
        self.syncer.run(full=True)
        s = self.state()
        self.assertEqual(s["periods"]["pi"]["name"], nxt["name"])
        self.assertEqual(sorted(b["title"] for b in s["auto"]["p1"]["bars"]), ["Access controls", "Audit and reporting"])


class WithoutJira(ApiCase):
    jira = False

    def test_everything_still_works_and_says_why_bars_are_empty(self):
        self.assertEqual(self.save(room(progress_panel([{"id": "b1", "source": {"kind": "issue", "key": "PLAT-1"}}])), 0)[0], 200)
        _, summary, _ = call(self.base, "POST", "/api/sync", {})
        self.assertEqual(summary["ok"], False)
        self.assertIn("not connected", summary["error"])
        s = self.state()
        self.assertEqual((s["progress"], s["sync"]["jiraConfigured"]), ({}, False))
        _, status, _ = call(self.base, "GET", "/api/jira/status")
        self.assertEqual((status["configured"], status["ok"]), (False, False))
        self.assertEqual(call(self.base, "GET", "/api/jira/fields")[0], 503)
        self.assertEqual(call(self.base, "POST", "/api/jira/preview", {"source": {"kind": "issue", "key": "PLAT-1"}})[0], 503)


if os.environ.get("OBEYA_TEST_DATABASE_URL"):
    for _case in (RoomApi, SettingsApi, JiraApi, WithoutJira):
        globals()[_case.__name__ + "Postgres"] = type(_case.__name__ + "Postgres", (_case,), {"postgres": True})


if __name__ == "__main__":
    unittest.main()
