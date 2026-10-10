"""Feeds (server/feeds.py): RSS and Atom parsing, feed discovery from a page, subscriptions, the agent tool's framing,
OPML round-trip, and the morning brief's headlines."""
import asyncio
import unittest
from unittest import mock

from smoke_test import client, shellb  # noqa: F401

import db
import feeds

RSS = b"""<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>Example &amp; Co</title><link>https://example.com/</link>
<item><title>First post</title><link>/posts/1</link><guid>p1</guid><pubDate>Tue, 06 Oct 2026 10:00:00 GMT</pubDate>
<description>&lt;p&gt;Hello &lt;b&gt;world&lt;/b&gt;&lt;/p&gt;</description><content:encoded>&lt;p&gt;Hello world, the long version.&lt;/p&gt;</content:encoded><dc:creator>Ada</dc:creator></item>
<item><title>Second</title><link>https://example.com/posts/2</link><guid>p2</guid><description>Short.</description></item>
</channel></rss>"""
ATOM = b"""<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom blog</title>
<link rel="alternate" href="https://blog.example.org/"/><link rel="self" href="https://blog.example.org/feed.xml"/>
<entry><id>urn:1</id><title>Entry one</title><link href="https://blog.example.org/one"/><published>2026-10-05T08:00:00Z</published>
<summary>A summary</summary><content type="html">&lt;p&gt;Body&lt;/p&gt;</content><author><name>Grace</name></author></entry></feed>"""
PAGE = b"""<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body>hi</body></html>"""


class Parse(unittest.TestCase):
    def test_rss(self):
        p = feeds.parse_feed(RSS, "https://example.com/feed")
        self.assertEqual(p["title"], "Example & Co")
        self.assertEqual(len(p["items"]), 2)
        a = p["items"][0]
        self.assertEqual((a["guid"], a["title"], a["link"], a["author"]), ("p1", "First post", "https://example.com/posts/1", "Ada"))
        self.assertEqual(a["summary"], "Hello world")
        self.assertEqual(a["content"], "Hello world, the long version.")
        self.assertAlmostEqual(a["published"], 1791280800.0, delta=1)

    def test_atom_and_discovery(self):
        p = feeds.parse_feed(ATOM, "https://blog.example.org/feed.xml")
        self.assertEqual(p["site"], "https://blog.example.org/")
        self.assertEqual(p["items"][0]["title"], "Entry one")
        self.assertEqual(p["items"][0]["content"], "Body")
        self.assertIsNone(feeds.parse_feed(PAGE, "https://x.example"))
        self.assertEqual(feeds.discover(PAGE, "https://x.example/blog/"), "https://x.example/feed.xml")
        self.assertIsNone(feeds.parse_feed(b"not xml at all", "https://x.example"))


def _fake_get(responses: dict):
    async def get(url, etag=None, modified=None):
        status, data = responses[url]
        return status, data, {"etag": "W/1"}
    return get


class Subscriptions(unittest.TestCase):
    def setUp(self):
        with db.conn() as c:
            c.execute("DELETE FROM feed_items"); c.execute("DELETE FROM feeds")

    def test_subscribe_refresh_tool_and_brief(self):
        responses = {"https://example.com/": (200, PAGE), "https://example.com/feed.xml": (200, RSS)}
        with mock.patch("feeds._get", _fake_get(responses)), mock.patch("tools._blocked_host", return_value=False):
            f = asyncio.run(feeds.subscribe("https://example.com/"))
            self.assertFalse(f["existing"])
            self.assertEqual(f["url"], "https://example.com/feed.xml")  # found from the page
            self.assertEqual(f["title"], "Example & Co")
            self.assertEqual(feeds.list_feeds()[0]["unread"], 0)  # the backlog starts read
            again = asyncio.run(feeds.subscribe("https://example.com/feed.xml"))
            self.assertTrue(again["existing"])
            # a new item arrives
            t0 = __import__("time").time()
            responses["https://example.com/feed.xml"] = (200, RSS.replace(b"<guid>p2</guid>", b"<guid>p2</guid></item><item><title>Third</title><guid>p3</guid><description>New!</description>"))
            r = asyncio.run(feeds.refresh(f["id"]))
            self.assertEqual(r["new"], 1)
            unread = feeds.items(unread=True)
            self.assertEqual([i["title"] for i in unread], ["Third"])
            acts = client.get("/api/activity?source=feeds").json()["items"]
            self.assertTrue(any(a["title"] == "1 new in Example & Co" for a in acts))
            self.assertEqual([h for h in __import__("commitments")._feeds(t0)], ["Example & Co: Third"])
            # tool: framed as untrusted, read marks read
            out = asyncio.run(feeds.feeds_tool({"action": "unread"}, None))
            self.assertIn("data from the publisher", out.text)
            self.assertIn("Third", out.text)
            out = asyncio.run(feeds.feeds_tool({"action": "read", "item": unread[0]["id"]}, None))
            self.assertIn("New!", out.text)
            self.assertEqual(feeds.items(unread=True), [])
            self.assertTrue(asyncio.run(feeds.feeds_tool({"action": "read", "item": "nope"}, None)).error)
            # a failing fetch lands on the feed, not on the caller
            responses["https://example.com/feed.xml"] = (500, b"")
            r = asyncio.run(feeds.refresh(f["id"]))
            self.assertEqual(r["error"], "HTTP 500")
            self.assertEqual(feeds.get_feed(f["id"])["error"], "HTTP 500")

    def test_local_addresses_refused_and_routes(self):
        with self.assertRaises(ValueError):
            asyncio.run(feeds.subscribe("http://127.0.0.1:8080/feed"))
        with self.assertRaises(ValueError):
            asyncio.run(feeds.subscribe("ftp://example.com/feed"))
        self.assertEqual(client.get("/api/feeds").json(), {"feeds": []})
        self.assertEqual(client.post("/api/feeds", json={"url": "http://192.168.1.2/x"}).status_code, 400)
        self.assertEqual(client.get("/api/feeds/items").json(), {"items": []})

    def test_opml_round_trip(self):
        with mock.patch("feeds._get", _fake_get({"https://example.com/feed.xml": (200, RSS), "https://blog.example.org/feed.xml": (200, ATOM)})), \
             mock.patch("tools._blocked_host", return_value=False):
            asyncio.run(feeds.subscribe("https://example.com/feed.xml", folder="News"))
            asyncio.run(feeds.subscribe("https://blog.example.org/feed.xml"))
            text = feeds.opml()
            self.assertIn('xmlUrl="https://example.com/feed.xml"', text)
            self.assertIn('text="News"', text)
            urls = feeds.opml_urls(text.encode())
            self.assertEqual(sorted(urls), [("https://blog.example.org/feed.xml", ""), ("https://example.com/feed.xml", "News")])
            r = client.get("/api/feeds/export.opml")
            self.assertEqual(r.status_code, 200)
            self.assertIn("opml", r.headers["content-type"])


if __name__ == "__main__":
    unittest.main()
