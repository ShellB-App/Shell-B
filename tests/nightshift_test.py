"""Night shift: the hours window, the queue, 👎 redrafts, and a run that yields to the owner and resumes, with fake turns."""
import asyncio
import json
import time
import unittest
from datetime import datetime
from unittest import mock

from smoke_test import client, shellb  # noqa: F401 — sets up the scratch copy

import db
import nightshift


def _reset():
    nightshift.init()
    with db.conn() as c:
        c.execute("DELETE FROM nightshift_jobs")


class Window(unittest.TestCase):
    def test_any_time_and_plain_window(self):
        self.assertTrue(nightshift.in_window("", datetime(2026, 10, 9, 14, 0)))
        self.assertTrue(nightshift.in_window("09:00-17:00", datetime(2026, 10, 9, 9, 0)))
        self.assertFalse(nightshift.in_window("09:00-17:00", datetime(2026, 10, 9, 17, 0)))

    def test_wraps_midnight(self):
        self.assertTrue(nightshift.in_window("23:00-06:30", datetime(2026, 10, 9, 23, 30)))
        self.assertTrue(nightshift.in_window("01:00-06:00", datetime(2026, 10, 9, 3, 0)))
        self.assertTrue(nightshift.in_window("23:00-06:30", datetime(2026, 10, 9, 6, 29)))
        self.assertFalse(nightshift.in_window("23:00-06:30", datetime(2026, 10, 9, 12, 0)))

    def test_malformed_means_any_time(self):
        self.assertTrue(nightshift.in_window("nights", datetime(2026, 10, 9, 12, 0)))


class Queue(unittest.TestCase):
    def setUp(self):
        _reset()

    def test_api_add_cancel_retry_delete(self):
        r = client.post("/api/nightshift", json={"prompt": "Compare home battery systems for a 10 kWh house\nwith details"})
        self.assertEqual(r.status_code, 200, r.text)
        j = r.json()["jobs"][0]
        self.assertEqual((j["kind"], j["status"], j["agentId"]), ("research", "queued", "minerva"))
        self.assertEqual(j["title"], "Compare home battery systems for a 10 kWh house")
        self.assertEqual(client.post("/api/nightshift", json={"prompt": "  "}).status_code, 400)
        self.assertEqual(client.post(f"/api/nightshift/{j['id']}/cancel").json()["jobs"][0]["status"], "cancelled")
        self.assertEqual(client.post(f"/api/nightshift/{j['id']}/retry").json()["jobs"][0]["status"], "queued")
        self.assertEqual(client.delete(f"/api/nightshift/{j['id']}").json()["jobs"], [])
        self.assertEqual(client.post("/api/nightshift/nope/cancel").status_code, 404)

    def test_status_reports_it(self):
        self.assertIn("nightShift", client.get("/api/status").json())

    def test_waits_for_owner_and_other_work(self):
        nightshift._last_human = time.time()
        self.assertEqual(nightshift._can_start(), "waiting for you to be away")
        nightshift._last_human = time.time() - 3600
        with mock.patch.object(nightshift, "active_convs", lambda: ["conv-x"]):
            self.assertEqual(nightshift._can_start(), "waiting for a chat to finish")
        with mock.patch.object(nightshift, "busy", lambda: "a to-do"):
            self.assertEqual(nightshift._can_start(), "waiting for a to-do")
        with mock.patch.object(nightshift, "active_convs", lambda: []), mock.patch.object(nightshift, "busy", lambda: None):
            self.assertIsNone(nightshift._can_start())


class Redrafts(unittest.TestCase):
    def setUp(self):
        _reset()
        conv = db.create_conversation("shellb", title="Router advice")
        self.conv = conv["id"]
        db.add_message(self.conv, "user", "Which mesh router should I buy?", {})
        self.reply = db.new_id("msg")
        db.add_message(self.conv, "assistant", "Buy any of them.", {"agentId": "shellb"}, msg_id=self.reply)
        with db.conn() as c:
            c.execute("INSERT OR REPLACE INTO feedback VALUES(?,?,?,?,?,?,?,?,?)",
                      (self.reply, self.conv, "shellb", "ShellB-Swift", "down", json.dumps(["too-short"]), "name models and prices",
                       None, time.time()))

    def test_queued_once_with_feedback_in_prompt(self):
        self.assertGreaterEqual(nightshift.sync_redrafts(), 1)
        self.assertEqual(nightshift.sync_redrafts(), 0)
        job = next(j for j in nightshift.jobs() if j["ref"] == self.reply)
        self.assertEqual((job["kind"], job["agentId"]), ("redraft", "shellb"))
        msg = nightshift.redraft_message(self.reply)
        for part in ("Which mesh router should I buy?", "Buy any of them.", "too short or shallow", "name models and prices"):
            self.assertIn(part, msg)

    def test_incognito_is_skipped(self):
        with db.conn() as c:
            c.execute("UPDATE conversations SET incognito=1 WHERE id=?", (self.conv,))
        nightshift.sync_redrafts()
        self.assertFalse(any(j["ref"] == self.reply for j in nightshift.jobs()))


class Run(unittest.TestCase):
    """A job yields when the owner comes back, resumes in the same chat, then finishes and reports."""
    def setUp(self):
        _reset()

    def test_yield_then_resume(self):
        job = nightshift.add_research("Summarise the state of solid-state batteries")
        calls, conv = [], db.create_conversation("minerva", title="Night shift test")["id"]

        async def fake_turn(j, conv_id, content, note, opts, on_conv):
            calls.append((conv_id, content, opts.get("localModel")))
            on_conv(conv)
            if len(calls) == 1:   # the owner shows up mid-turn
                nightshift.touch()
                return conv, "stopped", None, ""
            return conv, "complete", None, "Report: they're close."

        unloaded = []

        async def fake_unload(name):
            unloaded.append(name)

        async def go():
            with mock.patch.object(nightshift, "run_turn", fake_turn), \
                 mock.patch.object(nightshift, "abort_turn", lambda c: True), \
                 mock.patch.object(nightshift, "_unload_model", fake_unload), \
                 mock.patch.object(nightshift, "_make_space", mock.AsyncMock()), \
                 mock.patch.object(nightshift.activity, "post") as post:
                await nightshift._run(nightshift.get(job["id"]))
                await nightshift.make_room()
                self.assertEqual(nightshift.get(job["id"])["status"], "queued")
                self.assertEqual(nightshift.get(job["id"])["yields"], 1)
                await nightshift._run(nightshift.get(job["id"]))
                return post

        post = asyncio.run(go())
        self.assertIsNone(calls[0][0])
        self.assertEqual(calls[1][0], conv)          # same chat
        self.assertEqual(calls[1][1], nightshift.RESUME)
        self.assertEqual(calls[0][2], "ShellB-Titan")
        self.assertEqual(unloaded, ["ShellB-Titan"])
        done = nightshift.get(job["id"])
        self.assertEqual((done["status"], done["convId"]), ("done", conv))
        post.assert_called_once()
        self.assertEqual(post.call_args.args[:2], ("nightshift", "done"))


if __name__ == "__main__":
    unittest.main()
