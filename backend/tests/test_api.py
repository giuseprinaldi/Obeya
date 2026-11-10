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
from datetime import date, timedelta

from fake_jira.server import DEFAULT_TOKEN, make_fake_server, suggested_settings
from obeya.config import load_config
from obeya.db import Database
from obeya.server import App, make_server
from obeya.sources import Engine, SourceError
from obeya.sync import Syncer, collect_links


def call(base, method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            text = resp.read().decode()
            return resp.status, (json.loads(text) if text else None), resp.headers
    except urllib.error.HTTPError as err:
        with err:
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
    cfg_overrides: dict = {}

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
            jira_token=DEFAULT_TOKEN if cls.jira else "", **cls.cfg_overrides)
        cls.syncer = Syncer(cls.db, cls.cfg)   # not started: tests trigger runs themselves
        cls.app = App(cls.cfg, cls.db, cls.syncer)
        cls.server = make_server(cls.app)
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
        self.app.access._cached = None       # the passcode record lives in kv, which was just emptied
        self.app.access._failures.clear()

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
        self.assertEqual((s["boards"], s["metrics"], s["burnups"]), ({}, {}, {}))
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
        for ctype, expected in (("application/json", 400), ("application/json; charset=utf-8", 400),
                                ("text/plain", 415), ("application/x-www-form-urlencoded", 415)):
            req = urllib.request.Request(self.base + "/api/room", data=b"{nope", method="PUT",
                                         headers={"Content-Type": ctype})
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(req, timeout=10)
            with ctx.exception:
                self.assertEqual(ctx.exception.code, expected, ctype)
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
        self.assertEqual(body, {"jira": {"piField": "", "storyPointsField": "", "boardId": None, "showSummaries": True,
                                         "showAssignees": True,
                                         "blocked": {"flagged": True, "statuses": [], "labels": [], "links": False}},
                                "pis": []})
        status, body, _ = call(self.base, "PUT", "/api/settings", {
            "jira": {"piField": " customfield_10500 ", "boardId": "7", "showSummaries": False, "token": "secret"},
            "pis": [{"name": "B", "start": "2027-01-01", "end": "2027-03-31"},
                    {"name": "A", "start": "2026-10-01", "end": "2026-12-31"},
                    {"name": "Bad", "start": "nope", "end": "2026-12-31"}],
            "extra": 1})
        self.assertEqual(status, 200)
        self.assertEqual(body["jira"], {"piField": "customfield_10500", "storyPointsField": "", "boardId": None, "showSummaries": False,
                                        "showAssignees": True,
                                        "blocked": {"flagged": True, "statuses": [], "labels": [], "links": False}})
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


class FlowApi(ApiCase):
    def configure(self):
        call(self.base, "PUT", "/api/settings", suggested_settings(self.fake.dataset))

    def flow_room(self):
        return room(
            {"id": "k1", "type": "kanban", "title": "Flow", "span": 3,
             "data": {"columns": [{"id": "c1", "name": "Manual", "wip": 0}], "cards": [],
                      "jira": {"boardId": 1, "jql": "", "sprint": "active", "hiddenColumns": [], "maxCards": 6, "doneDays": 14}}},
            {"id": "k2", "type": "kanban", "title": "Manual board", "span": 3,
             "data": {"columns": [{"id": "c1", "name": "To do", "wip": 0}], "cards": [], "jira": None}},
            {"id": "q1", "type": "kpi", "title": "KPIs", "span": 3, "data": {"items": [
                {"id": "m1", "name": "Scope done", "metric": {"kind": "scope_done", "boardId": 1, "measure": "points"}},
                {"id": "m2", "name": "Throughput", "metric": {"kind": "throughput", "boardId": 1, "windowDays": 28}},
                {"id": "m3", "name": "Broken", "metric": {"kind": "wip", "boardId": 99}},
                {"id": "m4", "name": "Manual", "target": 5, "actual": 4, "history": [1, 2]}]}})

    def test_boards_and_metrics_arrive_in_state(self):
        self.configure()
        self.assertEqual(self.save(self.flow_room(), 0)[0], 200)
        status, summary, _ = call(self.base, "POST", "/api/sync", {})
        self.assertEqual((status, summary["ok"], summary["sources"]), (200, True, 4))
        s = self.state()
        self.assertEqual(sorted(s["boards"]), ["k1"])
        board = s["boards"]["k1"]
        self.assertEqual((board["ok"], board["boardName"], len(board["columns"])), (True, "Platform board", 4))
        self.assertEqual(sorted(s["metrics"]), ["m1", "m2", "m3"])
        scope = s["metrics"]["m1"]
        self.assertEqual((scope["ok"], scope["unit"]), (True, "%"))
        # Right-now metrics get a daily snapshot; look-back metrics bring their own weekly trend.
        self.assertEqual(scope["history"], [{"d": date.today().isoformat(), "value": scope["value"]}])
        self.assertGreater(len(s["metrics"]["m2"]["history"]), 1)
        self.assertFalse(s["metrics"]["m3"]["ok"])
        self.assertIn("Board 99", s["metrics"]["m3"]["error"])

    def test_lookback_metrics_are_not_recomputed_on_every_sync(self):
        self.configure()
        self.save(self.flow_room(), 0)
        self.assertEqual(self.syncer.run(full=True)["sources"], 4)
        # The next scheduled run refreshes everything except the fresh look-back metric.
        self.assertEqual(self.syncer.run(full=True)["sources"], 3)
        # "Sync now" and a settings change recompute it as well.
        self.assertEqual(self.syncer.run(full=True, force=True)["sources"], 4)
        self.assertEqual(sorted(self.state()["metrics"]), ["m1", "m2", "m3"])

    def test_blocked_rule_from_settings_reaches_the_board(self):
        self.configure()
        self.save(self.flow_room(), 0)
        self.syncer.run(full=True)
        self.assertEqual(self.state()["boards"]["k1"]["blocked"], 2)
        settings = suggested_settings(self.fake.dataset)
        settings["jira"]["blocked"] = {"flagged": False, "statuses": [], "labels": [], "links": False}
        settings["jira"]["showAssignees"] = False
        status, saved, _ = call(self.base, "PUT", "/api/settings", settings)
        self.assertEqual((status, saved["jira"]["blocked"]["flagged"], saved["jira"]["showAssignees"]), (200, False, False))
        self.syncer.run(full=True, force=True)
        board = self.state()["boards"]["k1"]
        self.assertEqual(board["blocked"], 0)
        self.assertTrue(all(card["assignee"] == "" for col in board["columns"] for card in col["cards"]))

    def test_preview_board_and_metric(self):
        self.configure()
        status, body, _ = call(self.base, "POST", "/api/jira/preview", {"board": {"boardId": 2}})
        self.assertEqual((status, body["ok"], body["boardType"]), (200, True, "kanban"))
        status, body, _ = call(self.base, "POST", "/api/jira/preview",
                               {"metric": {"kind": "lead_time", "jql": "project = DATA", "windowDays": 60}})
        self.assertEqual((status, body["ok"], body["unit"]), (200, True, "days"))
        self.assertEqual(call(self.base, "POST", "/api/jira/preview", {"board": {"boardId": None}})[0], 400)
        self.assertEqual(call(self.base, "POST", "/api/jira/preview", {"metric": {"kind": "wip"}})[0], 400)


class BurnupApi(ApiCase):
    TODAY = date.today()

    def configure(self):
        call(self.base, "PUT", "/api/settings", suggested_settings(self.fake.dataset))

    def burnup(self, source, period, panel_id="u1"):
        return {"id": panel_id, "type": "burnup", "title": "Burn-up", "span": 2, "data": {"source": source, "period": period}}

    def dates(self, days_back, days_ahead=20):
        return {"kind": "dates", "start": (self.TODAY - timedelta(days=days_back)).isoformat(),
                "end": (self.TODAY + timedelta(days=days_ahead)).isoformat()}

    def setUp(self):
        super().setUp()
        self.history_base = self.fake.history_searches

    def searches_with_history(self):
        """Searches that asked Jira for issue histories since this test began: the heavy call."""
        return self.fake.history_searches - self.history_base

    def test_a_new_chart_gets_the_days_before_it_existed(self):
        self.configure()
        link = {"kind": "issue", "key": "PLAT-1", "measure": "points"}
        self.save(room(self.burnup(link, self.dates(30))), 0)
        self.assertEqual(self.state()["burnups"], {})                    # nothing until a sync has run
        self.assertEqual(self.syncer.run(full=False)["sources"], 1)      # the quick run after an edit is enough
        chart = self.state()["burnups"]["u1"]
        self.assertEqual((chart["ok"], chart["key"], chart["unit"]), (True, "PLAT-1", "points"))
        days = [h["d"] for h in chart["history"]]
        self.assertEqual(days, [(self.TODAY - timedelta(days=n)).isoformat() for n in range(30, -1, -1)])
        # Today's point is the real snapshot; the days before it are replayed from history.
        self.assertEqual(chart["history"][-1], {"d": self.TODAY.isoformat(), "done": chart["done"], "total": chart["total"]})
        self.assertLess(chart["history"][0]["done"], chart["done"])
        self.assertTrue(all(h["done"] <= h["total"] for h in chart["history"]))

    def test_the_replay_runs_once_and_again_only_for_an_earlier_start(self):
        self.configure()
        link = {"kind": "jql", "jql": "project = DATA AND issuetype in (Story, Bug)"}
        self.save(room(self.burnup(link, self.dates(10))), 0)
        self.syncer.run(full=True)
        after_first = self.searches_with_history()
        self.assertEqual(after_first, 1)
        self.assertEqual(len(self.state()["burnups"]["u1"]["history"]), 11)
        self.syncer.run(full=True)
        self.syncer.run(full=False)
        self.assertEqual(self.searches_with_history(), after_first)      # not replayed on every sync
        # A later start needs nothing new; an earlier one is replayed, without a new link to compute.
        self.save(room(self.burnup(link, self.dates(5))), 1)
        self.assertEqual(self.syncer.run(full=False)["sources"], 0)
        self.assertEqual(self.searches_with_history(), after_first)
        self.save(room(self.burnup(link, self.dates(25))), 2)
        self.assertEqual(self.syncer.run(full=False)["sources"], 0)
        self.assertEqual(self.searches_with_history(), after_first + 1)
        self.assertEqual(len(self.state()["burnups"]["u1"]["history"]), 26)

    def test_real_snapshots_are_never_overwritten(self):
        self.configure()
        link = {"kind": "issue", "key": "DATA-1"}
        self.save(room(self.burnup(link, self.dates(6))), 0)
        self.syncer._compute(collect_links(self.db.get_room()["doc"]).specs, self.db.get_settings(), True, False)
        sid = collect_links(self.db.get_room()["doc"]).burnups["u1"]
        seen = self.TODAY - timedelta(days=3)
        self.db.store_results({}, [(sid, 1, 999)], seen)               # what a sync three days ago saw
        self.syncer.run(full=True)
        history = {h["d"]: h for h in self.state()["burnups"]["u1"]["history"]}
        self.assertEqual(len(history), 7)
        self.assertEqual((history[seen.isoformat()]["done"], history[seen.isoformat()]["total"]), (1, 999))
        self.assertNotEqual(history[(seen - timedelta(days=1)).isoformat()]["total"], 999)

    def test_pi_and_sprint_charts_follow_the_calendar_and_share_a_link_with_a_bar(self):
        self.configure()
        link = {"kind": "issue", "key": "PLAT-1"}
        self.save(room(self.burnup(link, {"kind": "pi"}, "u1"), self.burnup(link, {"kind": "sprint"}, "u2"),
                       progress_panel([{"id": "b1", "source": link}])), 0)
        summary = self.syncer.run(full=True)
        self.assertEqual((summary["ok"], summary["sources"]), (True, 1))      # one link, fetched once
        s = self.state()
        pi_start = date.fromisoformat(s["periods"]["pi"]["start"])
        first = date.fromisoformat(s["burnups"]["u1"]["history"][0]["d"])
        self.assertEqual(first, max(pi_start, self.TODAY - timedelta(days=179)))   # the earlier of the two starts wins
        self.assertEqual(s["burnups"]["u2"]["history"], s["burnups"]["u1"]["history"])
        # The bar on the same link gets the trend too, though only the last 60 days of it.
        self.assertGreater(len(s["progress"]["b1"]["history"]), 1)
        self.assertLessEqual(len(s["progress"]["b1"]["history"]), 61)

    def test_a_chart_without_a_period_or_with_a_broken_link_is_left_alone(self):
        self.configure()
        self.save(room(self.burnup({"kind": "issue", "key": "PLAT-1"}, {"kind": "dates", "start": "", "end": ""}, "u1"),
                       self.burnup({"kind": "issue", "key": "NOPE-1"}, self.dates(10), "u2"),
                       self.burnup(None, self.dates(10), "u3")), 0)
        self.assertTrue(self.syncer.run(full=True)["ok"])
        s = self.state()
        self.assertEqual(sorted(s["burnups"]), ["u1", "u2"])
        self.assertEqual(len(s["burnups"]["u1"]["history"]), 1)          # today's snapshot only
        self.assertFalse(s["burnups"]["u2"]["ok"])
        self.assertEqual(self.searches_with_history(), 0)

    def test_a_replay_that_fails_is_not_retried_on_every_sync(self):
        self.configure()
        link = {"kind": "jql", "jql": "project = PLAT AND issuetype = Story"}
        self.save(room(self.burnup(link, self.dates(10))), 0)
        original = Engine.daily_history
        calls = []

        def failing(engine, spec, first, last):
            calls.append(first)
            raise SourceError("This query matches more than 2000 issues. Narrow it down.")

        Engine.daily_history = failing
        try:
            self.assertTrue(self.syncer.run(full=True)["ok"])            # the bar itself still syncs
            self.syncer.run(full=True)
        finally:
            Engine.daily_history = original
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(self.state()["burnups"]["u1"]["history"]), 1)


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
    for _case in (RoomApi, SettingsApi, JiraApi, FlowApi, BurnupApi, WithoutJira):
        globals()[_case.__name__ + "Postgres"] = type(_case.__name__ + "Postgres", (_case,), {"postgres": True})


if __name__ == "__main__":
    unittest.main()
