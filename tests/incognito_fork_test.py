"""Going incognito from an open chat (privacy.py): the fork endpoint makes an incognito copy and never flags the original."""
import unittest

from smoke_test import client, shellb  # noqa: F401

import db


class IncognitoFork(unittest.TestCase):
    def setUp(self):
        self.conv = db.create_conversation("shellb", title="Personal details")
        db.add_message(self.conv["id"], "user", "Here is something about me")
        db.add_message(self.conv["id"], "assistant", "Noted", {"agentId": "shellb"})
        self.made = [self.conv["id"]]

    def tearDown(self):
        for cid in self.made:
            db.delete_conversation(cid)

    def fork(self, cid, **body):
        r = client.post(f"/api/conversations/{cid}/fork", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        self.made.append(r.json()["id"])
        return r.json()

    def test_incognito_fork_leaves_the_original_alone(self):
        fork = self.fork(self.conv["id"], incognito=True)
        self.assertNotEqual(fork["id"], self.conv["id"])
        self.assertTrue(fork["incognito"])
        self.assertTrue(db.get_conversation(fork["id"])["incognito"])
        self.assertFalse(db.get_conversation(self.conv["id"])["incognito"])
        self.assertEqual([m["content"] for m in db.list_messages(fork["id"])], ["Here is something about me", "Noted"])
        self.assertEqual(len(db.list_messages(self.conv["id"])), 2)

    def test_plain_fork_stays_normal(self):
        self.assertFalse(self.fork(self.conv["id"])["incognito"])

    def test_fork_of_incognito_chat_stays_incognito(self):
        inc = self.fork(self.conv["id"], incognito=True)
        self.assertTrue(self.fork(inc["id"])["incognito"])


if __name__ == "__main__":
    unittest.main()
