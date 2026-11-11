"""The edit lock and the Jira connection check."""
import threading
import time
import unittest
from datetime import date

from fake_jira.data import FLAGGED, PI_FIELD
from fake_jira.server import DEFAULT_TOKEN, make_fake_server, suggested_settings
from obeya.diagnostics import format_text, run_diagnostics
from obeya.jira_client import JiraClient
from tests.test_api import ApiCase, call, room

PASSCODE = "walk-the-walls"


def cookie_of(headers):
    """The name=value part of a Set-Cookie header, ready to send back."""
    raw = headers.get("Set-Cookie") or ""
    return raw.split(";")[0]


class EditLock(ApiCase):
    def set_passcode(self, new=PASSCODE, current="", cookie=""):
        return call(self.base, "PUT", "/api/passcode", {"current": current, "next": new},
                    headers={"Cookie": cookie} if cookie else None)

    def access(self, cookie=""):
        return call(self.base, "GET", "/api/state", headers={"Cookie": cookie} if cookie else None)[1]["access"]

    def test_open_until_a_passcode_is_set(self):
        self.assertEqual(self.access(), {"locked": False, "canEdit": True, "passcodeSet": False, "user": None})
        self.assertEqual(self.save(room(), 0)[0], 200)
        self.assertEqual(call(self.base, "GET", "/api/settings")[0], 200)

    def test_setting_a_passcode_locks_everyone_else_out(self):
        self.save(room(), 0)
        status, body, headers = self.set_passcode()
        self.assertEqual((status, body["locked"], body["canEdit"], body["passcodeSet"]), (200, True, True, True))
        mine = cookie_of(headers)
        self.assertTrue(mine.startswith("obeya_edit="))
        self.assertIn("HttpOnly", headers["Set-Cookie"])
        self.assertIn("SameSite=Strict", headers["Set-Cookie"])
        self.assertNotIn("Secure", headers["Set-Cookie"])        # plain http in this test

        # A screen or a visitor: can read the room, cannot change or query anything.
        self.assertEqual(self.access(), {"locked": True, "canEdit": False, "passcodeSet": True, "user": None})
        self.assertIsNotNone(self.state()["room"])
        self.assertEqual(call(self.base, "GET", "/api/health")[0], 200)
        doc = room()
        doc["roomName"] = "Defaced"
        for method, path, body in (
                ("PUT", "/api/room", {"room": doc, "baseVersion": 1}),
                ("PUT", "/api/settings", suggested_settings(self.fake.dataset)),
                ("GET", "/api/settings", None),
                ("POST", "/api/sync", {}),
                ("GET", "/api/jira/status", None),
                ("GET", "/api/jira/fields", None),
                ("GET", "/api/jira/boards", None),
                ("GET", "/api/jira/pi-values", None),
                ("GET", "/api/jira/diagnostics", None),
                ("POST", "/api/jira/preview", {"source": {"kind": "jql", "jql": "project = PLAT"}}),
                ("PUT", "/api/passcode", {"current": "", "next": "something-else"})):
            status, answer, _ = call(self.base, method, path, body)
            self.assertIn(status, (401, 403), f"{method} {path}")
            self.assertIn("error", answer)
        self.assertEqual(self.state()["room"]["roomName"], "Test room")

        # The browser that set it carries on editing.
        self.assertTrue(self.access(mine)["canEdit"])
        status, _, _ = call(self.base, "PUT", "/api/room", {"room": doc, "baseVersion": 1}, headers={"Cookie": mine})
        self.assertEqual(status, 200)

    def test_unlock_and_lock_again(self):
        self.set_passcode()
        status, body, _ = call(self.base, "POST", "/api/unlock", {"passcode": "wrong-guess"})
        self.assertEqual((status, body["error"]), (403, "That passcode is not right."))
        for bad in (None, 123456, "", {"passcode": PASSCODE}):
            self.assertEqual(call(self.base, "POST", "/api/unlock", {"passcode": bad})[0], 403)
        status, body, headers = call(self.base, "POST", "/api/unlock", {"passcode": PASSCODE})
        self.assertEqual((status, body["canEdit"]), (200, True))
        session = cookie_of(headers)
        self.assertEqual(self.save(room(), 0)[0], 401)
        self.assertEqual(call(self.base, "PUT", "/api/room", {"room": room(), "baseVersion": 0},
                              headers={"Cookie": session})[0], 200)
        status, body, headers = call(self.base, "POST", "/api/lock", {}, headers={"Cookie": session})
        self.assertEqual((status, body["canEdit"], body["locked"]), (200, False, True))
        self.assertIn("Max-Age=0", headers["Set-Cookie"])

    def test_forged_and_stale_cookies_are_refused(self):
        _, _, headers = self.set_passcode()
        good = cookie_of(headers)
        expires, version, signature = good.split("=", 1)[1].split(".")
        later = str(int(expires) + 3600)
        self.assertFalse(self.access(f"obeya_edit={later}.{version}.{signature}")["canEdit"])    # edited expiry
        self.assertFalse(self.access(f"obeya_edit={expires}.{version}.{'0' * 64}")["canEdit"])   # made-up signature
        self.assertFalse(self.access("obeya_edit=garbage")["canEdit"])
        self.assertFalse(self.access("obeya_edit=1.2")["canEdit"])
        past = int(time.time()) - 10
        access = self.app.access
        _, key = access._load()
        expired = f"obeya_edit={past}.{version}.{access._sign(key, past, int(version))}"
        self.assertFalse(self.access(expired)["canEdit"])                                        # correctly signed but old
        self.assertTrue(self.access(good)["canEdit"])

    def test_changing_the_passcode_ends_other_sessions(self):
        _, _, headers = self.set_passcode()
        first = cookie_of(headers)
        _, _, headers = call(self.base, "POST", "/api/unlock", {"passcode": PASSCODE})
        second = cookie_of(headers)
        # Changing needs the current passcode, even from an unlocked browser.
        self.assertEqual(self.set_passcode("new-passcode-1", current="not-it", cookie=first)[0], 403)
        status, body, headers = self.set_passcode("new-passcode-1", current=PASSCODE, cookie=first)
        self.assertEqual((status, body["canEdit"]), (200, True))
        self.assertTrue(self.access(cookie_of(headers))["canEdit"])
        self.assertFalse(self.access(first)["canEdit"])
        self.assertFalse(self.access(second)["canEdit"])
        self.assertEqual(call(self.base, "POST", "/api/unlock", {"passcode": PASSCODE})[0], 403)
        self.assertEqual(call(self.base, "POST", "/api/unlock", {"passcode": "new-passcode-1"})[0], 200)

    def test_passcode_rules(self):
        self.assertEqual(self.set_passcode("short")[0], 400)
        self.assertEqual(self.set_passcode(12345678)[0], 400)
        self.assertEqual(self.set_passcode("x" * 500)[0], 400)
        self.assertFalse(self.access()["locked"])
        self.assertEqual(call(self.base, "POST", "/api/unlock", {"passcode": "anything"})[0], 400)   # nothing to unlock

    def test_removing_the_passcode_reopens_editing(self):
        _, _, headers = self.set_passcode()
        mine = cookie_of(headers)
        self.assertEqual(self.set_passcode("", current="wrong", cookie=mine)[0], 403)
        status, body, _ = self.set_passcode("", current=PASSCODE, cookie=mine)
        self.assertEqual((status, body["locked"], body["passcodeSet"]), (200, False, False))
        self.assertEqual(self.save(room(), 0)[0], 200)
        # Setting the same passcode again must not bring the old session back to life.
        self.set_passcode()
        self.assertFalse(self.access(mine)["canEdit"])

    def test_wrong_guesses_are_limited(self):
        self.set_passcode()
        codes = [call(self.base, "POST", "/api/unlock", {"passcode": f"guess-{n}"})[0] for n in range(10)]
        self.assertEqual(codes, [403] * 8 + [429] * 2)
        status, body, _ = call(self.base, "POST", "/api/unlock", {"passcode": PASSCODE})
        self.assertEqual(status, 429)                      # even the right one has to wait
        self.assertIn("Wait a few minutes", body["error"])

    def test_the_passcode_is_not_stored_or_returned(self):
        self.set_passcode()
        with self.db.connect() as conn:
            stored = " ".join(str(r["value"]) for r in conn.execute("SELECT value FROM kv").fetchall())
        self.assertNotIn(PASSCODE, stored)
        self.assertNotIn(PASSCODE, str(self.state()))

    def test_reset_command_removes_a_forgotten_passcode(self):
        _, _, headers = self.set_passcode()
        self.assertTrue(self.app.access.reset())
        self.assertFalse(self.app.access.reset())
        self.assertEqual(self.access(), {"locked": False, "canEdit": True, "passcodeSet": False, "user": None})
        self.assertEqual(self.save(room(), 0)[0], 200)


class SignInProxy(ApiCase):
    """A reverse proxy signs people in and passes their name in a header."""
    cfg_overrides = {"auth_header": "X-Forwarded-User", "editors": ("alice", "Bob@Example.com")}

    def who(self, user=None, **extra):
        headers = {**({"X-Forwarded-User": user} if user else {}), **extra}
        return call(self.base, "GET", "/api/state", headers=headers)[1]["access"]

    def test_only_named_editors_can_edit(self):
        self.assertEqual(self.who(), {"locked": True, "canEdit": False, "passcodeSet": False, "user": None})
        self.assertEqual(self.who("carol"), {"locked": True, "canEdit": False, "passcodeSet": False, "user": "carol"})
        self.assertTrue(self.who("alice")["canEdit"])
        self.assertTrue(self.who("bob@example.com")["canEdit"])          # names are compared without case
        self.assertEqual(self.save(room(), 0)[0], 401)
        status, _, _ = call(self.base, "PUT", "/api/room", {"room": room(), "baseVersion": 0},
                            headers={"X-Forwarded-User": "alice"})
        self.assertEqual(status, 200)

    def test_a_passcode_still_works_alongside_the_proxy(self):
        status, _, headers = call(self.base, "PUT", "/api/passcode", {"current": "", "next": PASSCODE},
                                  headers={"X-Forwarded-User": "alice", "X-Forwarded-Proto": "https"})
        self.assertEqual(status, 200)
        self.assertIn("Secure", headers["Set-Cookie"])                    # https at the proxy
        _, _, headers = call(self.base, "POST", "/api/unlock", {"passcode": PASSCODE},
                             headers={"X-Forwarded-User": "carol"})
        self.assertTrue(call(self.base, "GET", "/api/state",
                             headers={"Cookie": cookie_of(headers), "X-Forwarded-User": "carol"})[1]["access"]["canEdit"])


class AnyoneSignedIn(ApiCase):
    cfg_overrides = {"auth_header": "X-Forwarded-User", "editors": ("*",)}

    def test_star_means_everyone_the_proxy_lets_in(self):
        self.assertFalse(call(self.base, "GET", "/api/state")[1]["access"]["canEdit"])
        self.assertTrue(call(self.base, "GET", "/api/state",
                             headers={"X-Forwarded-User": "anyone"})[1]["access"]["canEdit"])


# ---------- Jira connection check ----------

TODAY = date(2026, 11, 10)


def diagnose(settings=None, token=DEFAULT_TOKEN, configured=True, **fake_options):
    server = make_fake_server(port=0, today=TODAY, **fake_options)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        client = JiraClient(f"http://127.0.0.1:{server.server_address[1]}", token, timeout=5) if configured else None
        chosen = settings(suggested_settings(server.dataset)) if callable(settings) else suggested_settings(server.dataset)
        result = run_diagnostics(client, chosen, configured, TODAY)
    finally:
        server.shutdown()
        server.server_close()
    return result, {c["id"]: c for c in result["checks"]}


class Diagnostics(unittest.TestCase):
    def test_a_healthy_setup_passes_everything(self):
        result, checks = diagnose()
        self.assertTrue(result["ok"])
        self.assertEqual({c["status"] for c in result["checks"]}, {"pass"}, [c for c in result["checks"] if c["status"] != "pass"])
        self.assertEqual(list(checks), ["configured", "reachable", "token", "visible", "fields", "flagged", "hierarchy",
                                        "pi_field", "calendar", "boards", "statuses", "history", "age", "links"])
        self.assertIn("Blocks, Dependency", checks["links"]["detail"])     # "Relates" does not read as a dependency
        self.assertIn("9.12.4", checks["reachable"]["detail"])
        self.assertIn("Obeya service account", checks["token"]["detail"])
        self.assertIn("PI 26.4", checks["pi_field"]["detail"])
        self.assertIn("Platform board", checks["boards"]["detail"])
        self.assertTrue(all(c["fix"] == "" for c in result["checks"]))
        self.assertIn("Everything passed.", format_text(result))

    def test_not_configured(self):
        result, checks = diagnose(configured=False)
        self.assertFalse(result["ok"])
        self.assertEqual(checks["configured"]["status"], "fail")
        self.assertIn("JIRA_BASE_URL", checks["configured"]["fix"])
        self.assertEqual({c["status"] for c in result["checks"] if c["id"] not in ("configured", "calendar")}, {"skip"})
        self.assertEqual(checks["calendar"]["status"], "pass")     # the calendar does not need Jira

    def test_a_rejected_token_stops_the_rest(self):
        result, checks = diagnose(token="wrong")
        self.assertFalse(result["ok"])
        self.assertEqual((checks["configured"]["status"], checks["reachable"]["status"]), ("pass", "fail"))
        self.assertIn("401", checks["reachable"]["detail"])
        self.assertEqual(checks["token"]["status"], "skip")
        self.assertEqual(sum(1 for c in result["checks"] if c["status"] == "fail"), 1)   # one cause, one failure
        self.assertIn("1 failed", format_text(result))

    def test_parent_link_that_cannot_be_read_is_a_warning(self):
        result, checks = diagnose(parent_link_shape="opaque")
        self.assertTrue(result["ok"])
        self.assertEqual(checks["hierarchy"]["status"], "warn")
        self.assertIn("does not name the parent", checks["hierarchy"]["detail"])
        self.assertIn("one extra Jira call", checks["hierarchy"]["fix"])

    def test_missing_fields(self):
        _, checks = diagnose(hide_fields=(FLAGGED, "statuscategorychangedate", "customfield_10102"))
        self.assertEqual(checks["flagged"]["status"], "warn")
        self.assertEqual(checks["age"]["status"], "warn")
        self.assertEqual(checks["hierarchy"]["status"], "warn")
        self.assertIn("no Parent Link field", checks["hierarchy"]["detail"])
        def detect_points(settings):
            settings["jira"]["storyPointsField"] = ""
            return settings
        _, checks = diagnose(detect_points, hide_fields=("customfield_10101", "customfield_10106"))
        self.assertEqual(checks["fields"]["status"], "warn")
        self.assertIn("Epic Link, Story Points", checks["fields"]["detail"])
        # A field picked in settings that this Jira does not have (settings copied from another instance).
        _, checks = diagnose(hide_fields=("customfield_10106", PI_FIELD))
        self.assertEqual(checks["fields"]["status"], "warn")
        self.assertIn("customfield_10106) does not exist", checks["fields"]["detail"])
        self.assertEqual(checks["pi_field"]["status"], "fail")
        self.assertIn("does not exist", checks["pi_field"]["detail"])

    def test_no_histories_is_a_failure(self):
        result, checks = diagnose(changelog=False)
        self.assertFalse(result["ok"])
        self.assertEqual(checks["history"]["status"], "fail")
        self.assertIn("Cycle time", checks["history"]["fix"])

    def test_calendar_name_that_jira_does_not_use(self):
        def rename(settings):
            settings["pis"][1]["name"] = "PI26.4"       # the calendar is missing the space Jira uses
            return settings
        _, checks = diagnose(rename)
        self.assertEqual(checks["pi_field"]["status"], "warn")
        self.assertIn('"PI26.4"', checks["pi_field"]["detail"])
        self.assertIn("PI 26.4", checks["pi_field"]["detail"])
        self.assertIn("match Jira exactly", checks["pi_field"]["fix"])

    def test_settings_not_filled_in_yet(self):
        def blank(settings):
            settings["jira"].update(piField="", boardId=None)
            settings["pis"] = []
            return settings
        result, checks = diagnose(blank)
        self.assertTrue(result["ok"])
        self.assertEqual([checks[c]["status"] for c in ("pi_field", "calendar", "boards")], ["warn"] * 3)
        self.assertIn("2 boards are visible", checks["boards"]["detail"])

    def test_calendar_about_to_run_out(self):
        def last_pi(settings):
            settings["pis"] = [{"name": "PI 26.4", "start": "2026-10-01", "end": "2026-11-15"}]
            return settings
        _, checks = diagnose(last_pi)
        self.assertEqual(checks["calendar"]["status"], "warn")
        self.assertIn("nothing follows it", checks["calendar"]["detail"])

    def test_wrong_field_chosen_for_the_pi(self):
        def wrong(settings):
            settings["jira"]["piField"] = "customfield_10501"   # Earned Value: nobody fills it in
            return settings
        _, checks = diagnose(wrong)
        self.assertEqual(checks["pi_field"]["status"], "warn")
        self.assertIn("No issue has a value", checks["pi_field"]["detail"])


class DiagnosticsApi(ApiCase):
    def test_endpoint(self):
        call(self.base, "PUT", "/api/settings", suggested_settings(self.fake.dataset))
        status, body, _ = call(self.base, "GET", "/api/jira/diagnostics")
        self.assertEqual((status, body["ok"]), (200, True))
        self.assertEqual(len(body["checks"]), 14)
        self.assertEqual(set(body["checks"][0]), {"id", "label", "status", "detail", "fix"})


class DiagnosticsWithoutJira(ApiCase):
    jira = False

    def test_says_what_to_set(self):
        status, body, _ = call(self.base, "GET", "/api/jira/diagnostics")
        self.assertEqual((status, body["ok"]), (200, False))
        self.assertEqual(body["checks"][0]["status"], "fail")


if __name__ == "__main__":
    unittest.main()
