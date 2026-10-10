"""IMAP inbox (server/inbox.py) against a fake imaplib server: sync, read, search, rules starting turns, the tool's
framing and the owner-only routes."""
import asyncio
import email.utils
import time
import unittest
from unittest import mock

from smoke_test import client, shellb  # noqa: F401

import db
import inbox

ADMIN = {"x-shellb-admin": (db.DATA / "admin.key").read_text().strip()}


def _msg(uid, frm, subj, body, html=False, att=False):
    date = email.utils.formatdate(time.time() - uid * 60)
    boundary = "b1"
    if att:
        raw = (f"From: {frm}\r\nTo: evie@example.org\r\nSubject: {subj}\r\nDate: {date}\r\nMessage-ID: <m{uid}@example.org>\r\n"
               f"Content-Type: multipart/mixed; boundary={boundary}\r\n\r\n--{boundary}\r\nContent-Type: text/plain\r\n\r\n{body}\r\n"
               f"--{boundary}\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=invoice.pdf\r\n\r\n%PDF\r\n--{boundary}--\r\n")
    elif html:
        raw = (f"From: {frm}\r\nTo: evie@example.org\r\nSubject: {subj}\r\nDate: {date}\r\nMessage-ID: <m{uid}@example.org>\r\n"
               f"Content-Type: text/html\r\n\r\n<html><body><p>{body}</p><p>Second</p></body></html>\r\n")
    else:
        raw = (f"From: {frm}\r\nTo: evie@example.org\r\nSubject: {subj}\r\nDate: {date}\r\nMessage-ID: <m{uid}@example.org>\r\n"
               f"Content-Type: text/plain\r\n\r\n{body}\r\n")
    return raw.encode()


class FakeIMAP:
    """Just enough of imaplib.IMAP4_SSL for inbox.py: login/select/uid SEARCH|FETCH|STORE/logout."""
    store: dict[int, tuple[bytes, set]] = {}
    logins: list = []

    def __init__(self, host, port, ssl_context=None, timeout=None):
        self.host = host
    def login(self, user, pw):
        FakeIMAP.logins.append((user, pw))
        if pw != "app-pass":
            raise inbox.imaplib.IMAP4.error("AUTHENTICATIONFAILED")
    def select(self, folder, readonly=False): return "OK", [b"3"]
    def logout(self): return "BYE", []
    def uid(self, cmd, *args):
        if cmd == "SEARCH":
            crit = " ".join(a for a in args if a)
            uids = sorted(FakeIMAP.store)
            if crit.startswith("UID "):
                lo = int(crit.split()[1].split(":")[0])
                uids = [u for u in uids if u >= lo]
            elif "SUBJECT" in crit or "FROM" in crit or "TEXT" in crit:
                needle = crit.rsplit('"', 2)[-2].lower()
                field = "SUBJECT" if "SUBJECT" in crit else "FROM" if "FROM" in crit else "TEXT"
                uids = [u for u in uids if needle in (FakeIMAP.store[u][0].decode(errors="replace") if field == "TEXT" else
                        next((ln for ln in FakeIMAP.store[u][0].decode(errors="replace").split("\r\n") if ln.lower().startswith(field.lower() + ":")), "")).lower()]
            elif "UNSEEN" in crit:
                uids = [u for u in uids if "\\Seen" not in FakeIMAP.store[u][1]]
            return "OK", [" ".join(str(u) for u in uids).encode()]
        if cmd == "FETCH":
            uid = int(args[0])
            if uid not in FakeIMAP.store:
                return "OK", [None]
            raw, flags = FakeIMAP.store[uid]
            meta = f"{uid} (UID {uid} FLAGS ({' '.join(sorted(flags))}) RFC822.SIZE {len(raw)} BODY[] {{{len(raw)}}}".encode()
            return "OK", [(meta, raw), b")"]
        if cmd == "STORE":
            for u in str(args[0]).split(","):
                flags = FakeIMAP.store[int(u)][1]
                (flags.add if args[1].startswith("+") else flags.discard)("\\Seen")
            return "OK", [b""]
        raise AssertionError(cmd)


class Inbox(unittest.TestCase):
    def setUp(self):
        FakeIMAP.store = {1: (_msg(1, "Ada <ada@example.org>", "Hello there", "Plain body here"), set()),
                          2: (_msg(2, "shop@store.example", "Your invoice 42", "Amount due 12.50", att=True), set()),
                          3: (_msg(3, "Grace <grace@example.org>", "Re: plan", "Rich body", html=True), {"\\Seen"})}
        FakeIMAP.logins = []
        self.p = [mock.patch.object(inbox.imaplib, "IMAP4_SSL", FakeIMAP),
                  mock.patch.object(inbox, "_password", return_value="app-pass"),
                  mock.patch.object(inbox, "config", return_value={**inbox.DEFAULTS, "host": "imap.example.org", "user": "evie", "enabled": True})]
        for x in self.p:
            x.start()
        with db.conn() as c:
            c.execute("DELETE FROM inbox"); c.execute("DELETE FROM inbox_rules")
        self.saved_bt = inbox.begin_turn
        self.turns = []
        def fake_begin_turn(conv, body, **kw):
            self.turns.append((conv, body, kw))
            return None, None
        inbox.begin_turn = fake_begin_turn

    def tearDown(self):
        for x in self.p:
            x.stop()
        inbox.begin_turn = self.saved_bt
        for conv, _b, _k in self.turns:
            db.delete_conversation(conv["id"])

    def test_sync_rules_tool_and_routes(self):
        with db.conn() as c:
            c.execute("INSERT INTO inbox_rules(id, name, match_from, match_subject, agent, template, enabled, created, hits) VALUES('r1','Invoices','','invoice','shellb','File {{subject}} from {{from}}: {{body}}',1,0,0)")
        r = asyncio.run(inbox.poll())
        self.assertEqual(r, {"new": 3, "error": ""})
        rows = inbox.items()
        self.assertEqual([x["subject"] for x in rows], ["Hello there", "Your invoice 42", "Re: plan"])
        self.assertEqual(rows[1]["attachments"], ["invoice.pdf"])
        self.assertTrue(rows[2]["seen"] and rows[2]["snippet"].startswith("Rich body"))
        # the invoice matched the rule: one unattended turn, untrusted framing, the email as data
        self.assertEqual(len(self.turns), 1)
        conv, body, kw = self.turns[0]
        self.assertEqual(conv["title"], "Email: Your invoice 42")
        self.assertIn("File Your invoice 42 from shop@store.example: Amount due 12.50", body["content"])
        self.assertIn("data from the sender", body["content"])
        self.assertEqual(kw["interactive"], False)
        acts = client.get("/api/activity?source=email").json()["items"]
        self.assertTrue(any(a["title"].startswith("shop@store.example") and a["status"] == "due" for a in acts))
        self.assertTrue(any(a["title"].startswith("Ada") and a["status"] == "done" for a in acts))
        # a second poll finds nothing new
        self.assertEqual(asyncio.run(inbox.poll())["new"], 0)
        FakeIMAP.store[4] = (_msg(4, "x@y.z", "Later", "late body"), set())
        self.assertEqual(asyncio.run(inbox.poll())["new"], 1)
        # tool
        class Ctx: conv_id = "c"
        out = asyncio.run(inbox.read_email({"action": "unread"}, Ctx()))
        self.assertIn("data from the sender", out.text)
        self.assertIn("[uid 1] UNREAD", out.text)
        out = asyncio.run(inbox.read_email({"action": "read", "uid": 3}, Ctx()))
        self.assertIn("Rich body", out.text)
        self.assertIn("Second", out.text)
        self.assertIn("in_reply_to='<m3@example.org>'", out.text)
        out = asyncio.run(inbox.read_email({"action": "search", "query": "invoice"}, Ctx()))
        self.assertIn("Your invoice 42", out.text)
        asyncio.run(inbox.read_email({"action": "mark_read", "uid": 1}, Ctx()))
        self.assertIn("\\Seen", FakeIMAP.store[1][1])
        self.assertNotIn(1, [m["uid"] for m in inbox.items(unread=True)])
        # routes
        self.assertEqual(client.get("/api/email/inbox").status_code, 401)  # localhost isn't the owner
        self.assertEqual(client.get("/api/email/inbox", headers=ADMIN).json()["messages"], 4)
        self.assertEqual(client.put("/api/email/inbox", json={"host": "x"}).status_code, 403)

    def test_bad_password_is_reported_not_raised(self):
        with mock.patch.object(inbox, "_password", return_value="wrong"):
            r = asyncio.run(inbox.poll())
        self.assertEqual(r["new"], 0)
        self.assertIn("AUTHENTICATIONFAILED", r["error"])

    def test_tool_gates(self):
        import providers
        agent = {"id": "shellb", "model": "ShellB-Swift"}
        self.assertTrue(inbox.tool_allowed(agent, {}, "ShellB-Swift"))
        with mock.patch.object(providers, "is_cloud", return_value=True):
            self.assertFalse(inbox.tool_allowed(agent, {}, "anthropic/x"))
            self.assertTrue(inbox.tool_allowed(agent, {"cloudEmail": True}, "anthropic/x"))
        self.assertFalse(inbox.tool_allowed({"id": "aphrodite", "adult": True}, {}, "ShellB-Swift"))


if __name__ == "__main__":
    unittest.main()
