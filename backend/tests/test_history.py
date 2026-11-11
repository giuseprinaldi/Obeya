"""Earlier versions of the room: what changed in each, and the API that lists and returns them."""
import os
import unittest

from obeya.history import MAX_LINES, capped, describe_change, summary
from tests.test_api import ApiCase, call, room

PASSCODE = "walk-the-walls"


def panel(pid, title, kind="statement", **data):
    return {"id": pid, "type": kind, "title": title, "span": 1, "data": data}


def wall(wid, name, *panels, subtitle=""):
    return {"id": wid, "name": name, "subtitle": subtitle, "panels": list(panels)}


def doc(*walls, **settings):
    return {"v": 2, "roomName": "Room", "theme": "auto", "tvTheme": "dark", "accent": "cobalt",
            "density": "comfortable", "rotate": 0, "example": False, "walls": list(walls), **settings}


class DescribeChange(unittest.TestCase):
    BASE = doc(wall("w1", "Direction", panel("p1", "True north", text="Be visible"), panel("p2", "Focus")),
               wall("w2", "Delivery", panel("p3", "Sprint health", "kpi", items=[])))

    def test_first_version_and_no_change(self):
        self.assertEqual(describe_change(None, self.BASE), ["Room created"])
        self.assertEqual(describe_change(self.BASE, self.BASE), [])

    def test_room_settings(self):
        self.assertEqual(describe_change(self.BASE, {**self.BASE, "roomName": "Program Obeya"}), ["Room settings changed"])
        self.assertEqual(describe_change(self.BASE, {**self.BASE, "accent": "teal", "rotate": 30}), ["Room settings changed"])
        # Something outside the named settings is still reported, just not by name.
        self.assertEqual(describe_change({**self.BASE, "example": True}, self.BASE), ["Small changes"])

    def test_walls_added_removed_renamed_and_reordered(self):
        w1, w2 = self.BASE["walls"]
        added = doc(w1, w2, wall("w3", "Problems"))
        self.assertEqual(describe_change(self.BASE, added), ["Added wall Problems"])
        self.assertEqual(describe_change(added, self.BASE), ["Removed wall Problems"])
        self.assertEqual(describe_change(self.BASE, doc({**w1, "name": "True north"}, w2)),
                         ["Renamed wall Direction to True north"])
        self.assertEqual(describe_change(self.BASE, doc({**w1, "subtitle": "Why we exist"}, w2)),
                         ["Changed the subtitle of Direction"])
        self.assertEqual(describe_change(self.BASE, doc(w2, w1)), ["Walls reordered"])
        # Adding a wall in front of the others is an addition, not a reorder.
        self.assertEqual(describe_change(self.BASE, doc(wall("w0", "Overview"), w1, w2)), ["Added wall Overview"])

    def test_panels_added_removed_changed_and_reordered(self):
        w1, w2 = self.BASE["walls"]
        p1, p2 = w1["panels"]
        more = doc({**w1, "panels": [p1, p2, panel("p9", "PI burn-up", "burnup")]}, w2)
        self.assertEqual(describe_change(self.BASE, more), ["Added panel PI burn-up to Direction"])
        self.assertEqual(describe_change(more, self.BASE), ["Removed panel PI burn-up from Direction"])
        edited = doc({**w1, "panels": [{**p1, "data": {"text": "Be traceable"}}, p2]}, w2)
        self.assertEqual(describe_change(self.BASE, edited), ["Changed True north on Direction"])
        self.assertEqual(describe_change(self.BASE, doc({**w1, "panels": [p2, p1]}, w2)), ["Panels reordered on Direction"])
        # A renamed panel is named as it is now.
        renamed = doc({**w1, "panels": [{**p1, "title": "Purpose"}, p2]}, w2)
        self.assertEqual(describe_change(self.BASE, renamed), ["Changed Purpose on Direction"])

    def test_several_changes_at_once_are_all_listed(self):
        w1, w2 = self.BASE["walls"]
        after = doc({**w1, "name": "North", "panels": [w1["panels"][0]]}, wall("w3", "Risks"), roomName="Renamed")
        self.assertEqual(describe_change(self.BASE, after), [
            "Room settings changed", "Added wall Risks", "Removed wall Delivery",
            "Renamed wall Direction to North", "Removed panel Focus from North"])

    def test_junk_documents_do_not_break_it(self):
        for junk in ({}, [], "text", 7, {"walls": "nope"}, {"walls": [None, 3, {"panels": "x"}, {"id": 5, "panels": [None, {}]}]}):
            self.assertIsInstance(describe_change(junk, self.BASE), list)
            self.assertIsInstance(describe_change(self.BASE, junk), list)
            self.assertIsInstance(summary(junk), dict)
        self.assertEqual(describe_change({}, {"walls": [{"panels": [{}]}]}), ["Added wall Wall"])
        # Two walls sharing an id are still told apart, by position.
        twins = doc(wall("w", "One"), wall("w", "Two"))
        self.assertEqual(describe_change(twins, doc(wall("w", "One"))), ["Removed wall Two"])

    def test_summary_and_cap(self):
        self.assertEqual(summary(self.BASE), {"roomName": "Room", "walls": 2, "panels": 3})
        self.assertEqual(summary(None), {"roomName": "", "walls": 0, "panels": 0})
        lines = [f"line {n}" for n in range(MAX_LINES + 3)]
        self.assertEqual(capped(lines), (lines[:MAX_LINES], 3))
        self.assertEqual(capped(lines[:2]), (lines[:2], 0))


class HistoryApi(ApiCase):
    def history(self, query="", cookie=""):
        return call(self.base, "GET", "/api/room/history" + query, headers={"Cookie": cookie} if cookie else None)

    def test_nothing_saved_yet(self):
        status, body, _ = self.history()
        self.assertEqual((status, body), (200, {"current": 0, "versions": []}))

    def test_lists_versions_newest_first_with_what_changed(self):
        self.save(room(), 0)
        renamed = room()
        renamed["roomName"] = "Renamed"
        self.save(renamed, 1)
        with_panel = room(panel("p1", "True north", text="Be visible"))
        with_panel["roomName"] = "Renamed"
        self.save(with_panel, 2)
        status, body, _ = self.history()
        self.assertEqual((status, body["current"]), (200, 3))
        self.assertEqual([v["version"] for v in body["versions"]], [3, 2, 1])
        newest, middle, first = body["versions"]
        self.assertEqual((newest["changes"], newest["more"]), (["Added panel True north to Wall"], 0))
        self.assertEqual((newest["roomName"], newest["walls"], newest["panels"]), ("Renamed", 1, 1))
        self.assertEqual(middle["changes"], ["Room settings changed"])
        self.assertEqual((first["changes"], first["roomName"], first["panels"]), (["Room created"], "Test room", 0))
        self.assertEqual(newest["savedAt"], self.state()["updatedAt"])

    def test_returns_one_version_for_restoring(self):
        self.save(room(), 0)
        renamed = room()
        renamed["roomName"] = "Renamed"
        self.save(renamed, 1)
        status, body, _ = self.history("?version=1")
        self.assertEqual((status, body["version"], body["room"]["roomName"]), (200, 1, "Test room"))
        self.assertTrue(body["savedAt"])
        self.assertEqual(self.history("?version=2")[1]["room"], renamed)
        # Restoring is an ordinary save of that room: it becomes version 3 and the others stay listed.
        self.assertEqual(self.save(body["room"], 2)[0], 200)
        self.assertEqual(self.state()["room"]["roomName"], "Test room")
        listed = self.history()[1]
        self.assertEqual(([v["version"] for v in listed["versions"]], listed["current"]), ([3, 2, 1], 3))
        self.assertEqual(listed["versions"][0]["changes"], ["Room settings changed"])

    def test_unknown_and_malformed_versions(self):
        self.save(room(), 0)
        status, body, _ = self.history("?version=7")
        self.assertEqual(status, 404)
        self.assertIn("Version 7", body["error"])
        for bad in ("abc", "-1", "1.5", "9" * 12, "%C2%B2"):
            status, body, _ = self.history("?version=" + bad)
            self.assertEqual(status, 400, bad)
            self.assertIn("error", body)
        # An empty value asks for nothing in particular, so it is the list.
        self.assertEqual(self.history("?version=")[1]["current"], 1)

    def test_only_the_last_hundred_are_kept_and_listed(self):
        for n in range(103):
            saved = room()
            saved["roomName"] = f"Room {n + 1}"
            self.assertIsNotNone(self.db.save_room(saved, n))
        _, body, _ = self.history()
        versions = body["versions"]
        self.assertEqual((body["current"], len(versions), versions[0]["version"], versions[-1]["version"]), (103, 100, 103, 4))
        self.assertEqual(versions[0]["changes"], ["Room settings changed"])
        self.assertEqual(versions[-1]["changes"], ["The oldest version kept"])   # version 3 is gone, so what changed is unknown
        self.assertEqual(self.history("?version=3")[0], 404)
        self.assertEqual(self.history("?version=4")[1]["room"]["roomName"], "Room 4")

    def test_long_change_lists_are_cut_short(self):
        self.save(room(), 0)
        self.save(room(*[panel(f"p{n}", f"Panel {n}") for n in range(MAX_LINES + 4)]), 1)
        newest = self.history()[1]["versions"][0]
        self.assertEqual((len(newest["changes"]), newest["more"]), (MAX_LINES, 4))

    def test_a_locked_browser_cannot_read_the_history(self):
        self.save(room(), 0)
        status, _, headers = call(self.base, "PUT", "/api/passcode", {"current": "", "next": PASSCODE})
        self.assertEqual(status, 200)
        mine = (headers.get("Set-Cookie") or "").split(";")[0]
        for query in ("", "?version=1"):
            status, body, _ = self.history(query)
            self.assertEqual(status, 401, query)
            self.assertIn("error", body)
            self.assertEqual(self.history(query, cookie=mine)[0], 200, query)


if os.environ.get("OBEYA_TEST_DATABASE_URL"):
    globals()["HistoryApiPostgres"] = type("HistoryApiPostgres", (HistoryApi,), {"postgres": True})


if __name__ == "__main__":
    unittest.main()
