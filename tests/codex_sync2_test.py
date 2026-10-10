"""CalDAV/CardDAV sync accounts (server/codex_sync.py): bookkeeping, CardDAV push and pull against a fake WebDAV
server, and error recording. The caldav library is not exercised (no server); its path is covered by the same
import_entries/push bookkeeping."""
import time
import unittest
from unittest import mock

from smoke_test import client, shellb  # noqa: F401

import codex
import codex_sync as cs
import db

ADMIN = {"x-shellb-admin": (db.DATA / "admin.key").read_text().strip()}


def setUpModule():
    global _spawn
    _spawn = mock.patch.object(codex, "_spawn", lambda coro: coro.close())
    _spawn.start()


def tearDownModule():
    _spawn.stop()


class FakeDav:
    """A tiny CardDAV collection: PROPFIND listing, GET, PUT with etags and If-Match."""
    def __init__(self):
        self.cards: dict[str, tuple[str, str]] = {}  # href → (etag, vcf)
        self.n = 0

    def __call__(self, a, method, url, body=None, headers=None, timeout=60):
        headers = headers or {}
        r = mock.Mock()
        if method == "PROPFIND":
            items = "".join(f'<d:response><d:href>{h}</d:href><d:propstat><d:prop><d:getetag>"{e}"</d:getetag><d:getcontenttype>text/vcard</d:getcontenttype><d:resourcetype/></d:prop></d:propstat></d:response>'
                            for h, (e, _v) in self.cards.items())
            r.status_code, r.content, r.text = 207, f'<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>{url}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>{items}</d:multistatus>'.encode(), ""
            r.headers = {}
            return r
        if method == "GET":
            if url in self.cards:
                r.status_code, r.text, r.headers = 200, self.cards[url][1], {"etag": f'"{self.cards[url][0]}"'}
            else:
                r.status_code, r.text, r.headers = 404, "", {}
            return r
        if method == "PUT":
            if "If-Match" in headers and headers["If-Match"] != f'"{self.cards.get(url, ("", ""))[0]}"':
                r.status_code, r.headers, r.text = 412, {}, ""
                return r
            self.n += 1
            etag = f"e{self.n}"
            self.cards[url] = (etag, body)
            r.status_code, r.headers, r.text = 201, {"etag": f'"{etag}"'}, ""
            return r
        raise AssertionError(method)


class Accounts(unittest.TestCase):
    def tearDown(self):
        for a in cs.sync_accounts():
            cs.remove_account(a["id"])

    def test_add_update_remove_and_routes(self):
        a = cs.add_account("carddav", "https://cloud.example.org/dav/addressbooks/me/contacts/", "me", "pw", "Cloud", 30)
        self.assertTrue(a["hasPassword"] and a["everyMinutes"] == 30 and a["kind"] == "carddav")
        self.assertEqual(cs._password(a["id"]), "pw")
        self.assertEqual(oct(cs._pass_path(a["id"]).stat().st_mode)[-3:], "600")
        self.assertEqual(cs.update_account(a["id"], {"enabled": False, "everyMinutes": 2})["everyMinutes"], 5)  # floor
        listed = client.get("/api/codex/sync").json()["accounts"]
        self.assertEqual([x["id"] for x in listed], [a["id"]])
        self.assertNotIn("password", listed[0])
        self.assertEqual(client.post("/api/codex/sync", json={"kind": "caldav", "url": "x"}).status_code, 403)  # localhost isn't admin
        self.assertEqual(client.post("/api/codex/sync", json={"kind": "caldav", "url": "not a url", "user": "u", "password": "p"}, headers=ADMIN).status_code, 400)
        self.assertTrue(cs.remove_account(a["id"]))
        self.assertFalse(cs._pass_path(a["id"]).exists())
        self.assertEqual(client.delete(f"/api/codex/sync/{a['id']}", headers=ADMIN).status_code, 404)


class CardDav(unittest.TestCase):
    def setUp(self):
        self.a = cs.add_account("carddav", "https://cloud.example.org/dav/addressbooks/me/contacts/", "me", "pw", "Cloud")
        self.fake = FakeDav()
        self.p = mock.patch.object(cs, "_dav", self.fake)
        self.p.start()
        self.made = []

    def tearDown(self):
        self.p.stop()
        cs.remove_account(self.a["id"])
        for eid in self.made:
            codex.delete(eid)
        with db.conn() as c:
            for r in c.execute("SELECT id FROM codex_entries WHERE kind='contact' AND title IN ('Grace Hopper', 'Ada Lovelace')"):
                codex.delete(r["id"])

    def test_push_then_pull_and_conflicts(self):
        base = self.a["url"]
        # the server already has Ada; we have Grace (never synced)
        self.fake.cards[base + "ada.vcf"] = ("e0", "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:ada-1\r\nFN:Ada Lovelace\r\nEMAIL:ada@example.org\r\nEND:VCARD\r\n")
        grace = codex.create({"kind": "contact", "title": "Grace Hopper", "meta": {"email": "grace@example.org"}})
        self.made.append(grace["id"])
        out = cs.run_sync(self.a["id"])
        self.assertEqual(out["error"], "", out)
        self.assertGreaterEqual(out["created"], 1)  # a first sync pushes every local contact (Grace among them)
        self.assertEqual(out["pulled"], 1)
        # Grace went up with a uid and now carries sync meta with an etag; Ada came down with hers
        g = codex.get(grace["id"])
        self.assertEqual(g["meta"]["sync"]["account"], self.a["id"])
        self.assertTrue(g["meta"]["sync"]["href"].startswith(base) and g["meta"]["uid"])
        self.assertIn(g["meta"]["sync"]["href"], self.fake.cards)
        with db.conn() as c:
            ada = c.execute("SELECT id, meta FROM codex_entries WHERE kind='contact' AND title='Ada Lovelace'").fetchone()
        self.assertIsNotNone(ada)
        import json
        self.assertEqual(json.loads(ada["meta"])["sync"]["href"], base + "ada.vcf")
        acct = cs._acct(self.a["id"])
        self.assertTrue(acct["lastSync"] and not acct["lastError"])
        # nothing changed: a second run pushes and pulls nothing
        time.sleep(0.05)
        out = cs.run_sync(self.a["id"])
        self.assertEqual((out["pushed"], out["created"], out["pulled"], out["updated"]), (0, 0, 0, 0))
        # a local edit goes up (If-Match with the stored etag); a stale etag is reported, not forced
        time.sleep(0.05)
        codex.update(grace["id"], {"meta": {**g["meta"], "phone": "+1 555 0100"}})
        out = cs.run_sync(self.a["id"])
        self.assertEqual(out["pushed"], 1)
        self.assertIn("TEL:+1 555 0100", self.fake.cards[g["meta"]["sync"]["href"]][1])
        href = g["meta"]["sync"]["href"]
        self.fake.cards[href] = ("server-changed", self.fake.cards[href][1])
        time.sleep(0.05)
        codex.update(grace["id"], {"meta": {**codex.get(grace["id"])["meta"], "company": "Navy"}})
        out = cs.run_sync(self.a["id"])
        self.assertTrue(any("kept" in e for e in out["errors"]), out)

    def test_server_failure_is_recorded(self):
        with mock.patch.object(cs, "carddav_list", side_effect=RuntimeError("PROPFIND 401: nope")):
            out = cs.run_sync(self.a["id"])
        self.assertIn("PROPFIND 401", out["error"])
        self.assertIn("PROPFIND 401", cs._acct(self.a["id"])["lastError"])
        acts = client.get("/api/activity?source=codex").json()["items"]
        self.assertTrue(any("Sync with Cloud" in x["title"] for x in acts))


if __name__ == "__main__":
    unittest.main()
