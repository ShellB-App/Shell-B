"""Chat-to-chat messages (server/chatmail.py): list_sessions finds other chats, leave_message wakes an idle recipient,
queues for a busy one, and stops waking once a back-and-forth runs past MAX_HOPS."""
import asyncio
import unittest

from smoke_test import client, shellb  # noqa: F401

import chatmail
import db
import privacy
from public_api_test import fake_begin_turn, CALLS
from tools import ToolContext


def ctx(conv_id):
    async def emit(_):
        pass
    return ToolContext(conv_id=conv_id, message_id="m", agent={"id": "shellb"}, settings={}, emit=emit)


class Wake(unittest.TestCase):
    def setUp(self):
        self._real, self._active = chatmail.begin_turn, chatmail.ACTIVE
        chatmail.begin_turn, chatmail.ACTIVE = fake_begin_turn, {}
        chatmail._wakes.clear()
        chatmail._hops.clear()
        CALLS.clear()
        self.a = db.create_conversation("shellb", title="Sender chat")
        self.b = db.create_conversation("shellb", title="Recipient chat")

    def tearDown(self):
        chatmail.begin_turn, chatmail.ACTIVE = self._real, self._active
        for c in (self.a, self.b):
            db.delete_conversation(c["id"])

    def run_tool(self, fn, args, conv):
        async def go():
            r = await fn(args, ctx(conv))
            await asyncio.sleep(0)
            return r
        return asyncio.run(go())

    def test_list_sessions_shows_others_not_self_or_hidden(self):
        hidden = privacy.mark_incognito(db.create_conversation("shellb", title="Secret chat")["id"])
        try:
            out = self.run_tool(chatmail.list_sessions, {"query": "chat"}, self.a["id"]).text
            self.assertIn(self.b["id"], out)
            self.assertNotIn(self.a["id"], out)
            self.assertNotIn(hidden["id"], out)
        finally:
            db.delete_conversation(hidden["id"])

    def test_idle_recipient_starts_a_turn_and_reads_the_message(self):
        r = self.run_tool(chatmail.leave_message, {"conversation_id": self.b["id"], "text": "Build is green"}, self.a["id"])
        self.assertIn("started a turn", r.text)
        self.assertEqual(len(CALLS), 1)
        call = CALLS[0]
        self.assertEqual(call["conv"], self.b["id"])
        self.assertIn("Build is green", call["body"]["content"])
        self.assertIn(self.a["id"], call["body"]["content"])
        self.assertFalse(call["interactive"])
        self.assertIn("Woken by another chat", call["note"])
        self.assertEqual(chatmail.unread_count(self.b["id"]), 0)

    def test_wake_false_only_leaves_it_in_the_mailbox(self):
        r = self.run_tool(chatmail.leave_message, {"conversation_id": self.b["id"], "text": "fyi", "wake": False}, self.a["id"])
        self.assertIn("next turn", r.text)
        self.assertEqual(CALLS, [])
        self.assertEqual(chatmail.unread_count(self.b["id"]), 1)

    def test_busy_recipient_gets_it_when_its_turn_ends(self):
        chatmail.ACTIVE[self.b["id"]] = {}

        async def go():
            r = await chatmail.leave_message({"conversation_id": self.b["id"], "text": "when you can"}, ctx(self.a["id"]))
            self.assertIn("busy", r.text)
            await asyncio.sleep(0.1)
            self.assertEqual(CALLS, [])
            chatmail.ACTIVE.pop(self.b["id"])
            await asyncio.sleep(2.2)
        asyncio.run(go())
        self.assertEqual([c["conv"] for c in CALLS], [self.b["id"]])

    def test_ping_pong_stops_waking_past_the_hop_limit(self):
        chatmail._hops[self.a["id"]] = chatmail.MAX_HOPS  # a's turn was woken by a message already at the limit
        r = self.run_tool(chatmail.leave_message, {"conversation_id": self.b["id"], "text": "and again"}, self.a["id"])
        self.assertIn("not woken", r.text)
        self.assertEqual(CALLS, [])
        self.assertEqual(chatmail.unread_count(self.b["id"]), 1)

    def test_owner_api_wakes_only_when_asked(self):
        self.assertEqual(client.post(f"/api/mailbox/{self.b['id']}", json={"text": "note"}).json()["delivery"], "mailbox")
        r = client.post(f"/api/mailbox/{self.b['id']}", json={"text": "go", "wake": True})
        self.assertEqual(r.json()["delivery"], "started")


if __name__ == "__main__":
    unittest.main()
