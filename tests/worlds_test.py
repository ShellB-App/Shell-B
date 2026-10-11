"""Worlds app server pieces: card notes with places, removals and GLB media (worldnotes.py), the 3D model catalog
(maps.py) and the Earth imagery proxy's validation (earthview.py)."""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from smoke_test import client, shellb  # noqa: F401

import earthview
import maps
import worldnotes


class Notes(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="worlds-"))
        self.p = mock.patch.multiple(worldnotes, DIR=self.tmp, MEDIA=self.tmp / "media", NOTES=self.tmp / "notes.json")
        self.p.start()

    def tearDown(self):
        self.p.stop()

    def test_place_round_trip_and_remove(self):
        r = client.post("/api/worlds/notes", json={"body": "earth", "feature": "Lascaux II", "lat": 45.05, "lon": 1.17, "kind": "site",
                                                  "color": "#ff0000", "summary": "A replica.", "facts": [{"label": "Opened", "value": "1983"}]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["note"]["place"], {"lat": 45.05, "lon": 1.17, "kind": "site", "color": "#ff0000"})
        places = client.get("/api/worlds/places?body=earth").json()["places"]
        self.assertEqual([p["feature"] for p in places], ["Lascaux II"])
        self.assertEqual(client.get("/api/worlds/places?body=mars").json()["places"], [])
        # removing one fact by match, then the place itself
        r = client.post("/api/worlds/notes", json={"body": "earth", "feature": "Lascaux II", "remove": [{"part": "facts", "match": "opened"}]})
        self.assertEqual(r.json()["note"]["facts"], [])
        r = client.post("/api/worlds/notes", json={"body": "earth", "feature": "Lascaux II", "remove": [{"part": "place"}]})
        self.assertNotIn("place", r.json()["note"])
        self.assertEqual(client.get("/api/worlds/places?body=earth").json()["places"], [])
        # a bad removal is reported, not fatal
        r = client.post("/api/worlds/notes", json={"body": "earth", "feature": "Lascaux II", "remove": [{"part": "facts", "match": "nothing like this"}]})
        self.assertTrue(any("nothing in facts matched" in p for p in r.json()["problems"]))

    def test_bad_place_rejected(self):
        r = client.post("/api/worlds/notes", json={"body": "earth", "feature": "X", "lat": 95, "lon": 0})
        self.assertEqual(r.status_code, 400)
        r = client.post("/api/worlds/notes", json={"body": "earth", "feature": "X", "lat": "north", "lon": 0})
        self.assertEqual(r.status_code, 400)
        r = client.post("/api/worlds/notes", json={"body": "earth", "feature": "X", "lat": 1, "lon": 2, "kind": "dragon"})
        self.assertEqual(r.json()["note"]["place"]["kind"], "place")

    def test_glb_media_by_magic(self):
        glb = b"glTF" + b"\x02\x00\x00\x00" + b"\x00" * 40

        class R:
            status_code = 200
            headers = {"content-type": "application/octet-stream"}

            def raise_for_status(self):
                pass

            async def aiter_bytes(self):
                yield glb

        class Stream:
            async def __aenter__(self):
                return R()

            async def __aexit__(self, *a):
                return False

        class C:
            def stream(self, *a, **k):
                return Stream()

            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return False

        with mock.patch.object(worldnotes.scrape, "client", lambda timeout=90: C()):
            got = asyncio.run(worldnotes._fetch_media("https://example.org/model.glb"))
        self.assertEqual((got["kind"], got["mime"]), ("model", "model/gltf-binary"))
        self.assertTrue((self.tmp / "media" / got["file"]).exists())
        self.assertTrue(got["file"].endswith(".glb"))
        r = client.get(f"/api/worlds/media/{got['file']}")
        self.assertEqual(r.headers["content-type"].split(";")[0], "model/gltf-binary")

    def test_read_tool(self):
        asyncio.run(worldnotes.annotate({"body": "venus", "feature": "Venera 13 (mission)", "summary": "Landed 1982."}, by="test"))
        out = asyncio.run(worldnotes.read_tool({"body": "venus", "feature": "Venera 13"}, None))
        self.assertIn("Landed 1982.", out.text)
        self.assertFalse(out.error)
        listing = asyncio.run(worldnotes.read_tool({}, None))
        self.assertIn("Venera 13 (venus)", listing.text)
        self.assertIn("No card notes yet", asyncio.run(worldnotes.read_tool({"body": "mars", "feature": "Nowhere"}, None)).text)


class Models(unittest.TestCase):
    def test_catalog_lists_only_present_files(self):
        tmp = Path(tempfile.mkdtemp(prefix="models-"))
        (tmp / "apollo-lm.glb").write_bytes(b"glTF" + b"\x00" * 20)
        (tmp / "catalog.json").write_text(json.dumps([
            {"id": "apollo-lm", "name": "Apollo Lunar Module", "file": "apollo-lm.glb", "landmarks": ["apollo-11"], "credit": "NASA"},
            {"id": "missing", "name": "Not downloaded", "file": "missing.glb"},
            {"id": "../evil", "name": "bad id"},
        ]))
        with mock.patch.object(maps, "MODELS", tmp):
            ms = client.get("/api/maps/models").json()["models"]
            self.assertEqual([m["id"] for m in ms], ["apollo-lm"])
            self.assertTrue(ms[0]["url"].startswith("/api/maps/models/apollo-lm.glb?v="))
            self.assertNotIn("file", ms[0])
            r = client.get("/api/maps/models/apollo-lm.glb")
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.headers["content-type"], "model/gltf-binary")
            self.assertEqual(client.get("/api/maps/models/missing.glb").status_code, 404)
            self.assertIn(client.get("/api/maps/models/..%2Fcatalog.glb").status_code, (400, 404))  # auth refuses the traversal first
            note = maps.prompt_note("base")
            self.assertIn("3D models installed", note)
            self.assertIn("apollo-lm", note)


class Imagery(unittest.TestCase):
    def test_catalog_and_validation(self):
        d = client.get("/api/earth/imagery").json()
        self.assertIn("modis", [l["id"] for l in d["layers"]])
        self.assertRegex(d["latest"], r"^\d{4}-\d{2}-\d{2}$")
        # nothing leaves the machine for a bad request
        with mock.patch.object(earthview.httpx, "AsyncClient", side_effect=AssertionError("must not fetch")):
            self.assertEqual(client.get("/api/earth/imagery/modis/2020-01-01/9/999/0.jpg").status_code, 404)   # x out of range
            self.assertEqual(client.get("/api/earth/imagery/modis/20200101/3/1/1.jpg").status_code, 404)      # bad date
            self.assertEqual(client.get("/api/earth/imagery/nope/2020-01-01/3/1/1.jpg").status_code, 404)     # unknown layer
            self.assertEqual(client.get("/api/earth/imagery/modis/2020-01-01/3/1/1.png").status_code, 404)    # wrong type
            self.assertEqual(client.get("/api/earth/radar/2026-10-10T18:15:00Z/3/1/1.png").status_code, 404)  # not a half hour
            self.assertEqual(client.get("/api/earth/radar/2026-10-10T18:30:00Z/8/1/1.png").status_code, 404)  # past IMERG's level 6
        self.assertEqual(earthview.clamp_date(earthview.LAYERS["modis"], "1999-01-01"), "2000-02-24")
        self.assertEqual(earthview.clamp_date(earthview.LAYERS["modis"], "2999-01-01"), earthview.latest_date())
        self.assertEqual(earthview.clamp_date(earthview.LAYERS["bluemarble"], "2020-05-05"), "2004-08-01")

    def test_tile_cached_on_disk(self):
        tmp = Path(tempfile.mkdtemp(prefix="earth-"))

        class Resp:
            status_code = 200
            headers = {"content-type": "image/jpeg"}
            content = b"\xff\xd8jpegdata"

        class C:
            calls = 0

            def __init__(self, *a, **k):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return False

            async def get(self, url):
                C.calls += 1
                self.url = url
                return Resp()

        with mock.patch.object(earthview, "DATA", tmp), mock.patch.object(earthview.httpx, "AsyncClient", C):
            r = client.get("/api/earth/imagery/modis/2021-06-01/3/2/1.jpg")
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.content, Resp.content)
            self.assertTrue((tmp / "imagery" / "modis" / "2021-06-01" / "3" / "2" / "1.jpg").exists())
            r = client.get("/api/earth/imagery/modis/2021-06-01/3/2/1.jpg")
            self.assertEqual(r.status_code, 200)
            self.assertEqual(C.calls, 1)  # second time from disk


if __name__ == "__main__":
    unittest.main()
