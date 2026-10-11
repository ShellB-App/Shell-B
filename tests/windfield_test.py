"""Wind fields (server/windfield.py): index parsing, packing, hour clamping, and the route with the network mocked."""
import asyncio
import json
import struct
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from smoke_test import client, shellb  # noqa: F401

import windfield

IDX = """1:0:d=2026101112:PRMSL:mean sea level:anl:
2:1031194:d=2026101112:CLWMR:1 hybrid level:anl:
3:1500000:d=2026101112:UGRD:10 m above ground:anl:
4:1600000:d=2026101112:VGRD:10 m above ground:anl:
"""


class Parse(unittest.TestCase):
    def test_idx(self):
        rows = windfield.parse_idx(IDX)
        self.assertEqual(rows[0], ("PRMSL:mean sea level", 0, 1031193))
        self.assertEqual(rows[2], ("UGRD:10 m above ground", 1500000, 1599999))
        self.assertEqual(rows[3], ("VGRD:10 m above ground", 1600000, None))

    def test_pack_and_thin(self):
        data, nx, ny = windfield.thin_and_scale([float(i) for i in range(16)], 4, 4, 100, 0)
        self.assertEqual((nx, ny), (2, 2))
        self.assertEqual(struct.unpack("<4h", data), (0, 200, 800, 1000))
        blob = windfield.pack({"a": 1}, [data])
        self.assertEqual(blob[:4], b"SBWF")
        n = struct.unpack("<I", blob[4:8])[0]
        self.assertEqual(json.loads(blob[8:8 + n]), {"a": 1})
        self.assertEqual(blob[8 + n:], data)
        # Int16 clamping
        big, _, _ = windfield.thin_and_scale([1e9, -1e9, 0, 0], 2, 2, 100, 0)
        self.assertEqual(struct.unpack("<h", big[:2])[0], 32767)

    def test_clamp_hour(self):
        self.assertEqual(windfield.clamp_hour(-5), 0)
        self.assertEqual(windfield.clamp_hour(4), 3)
        self.assertEqual(windfield.clamp_hour(5), 6)
        self.assertEqual(windfield.clamp_hour(999), 240)

    def test_urls(self):
        self.assertEqual(windfield.file_url("20261011/12", 6, idx=True),
                         "https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.20261011/12/atmos/gfs.t12z.pgrb2.0p25.f006.idx")
        self.assertEqual(windfield.run_time("20261011/12").isoformat(), "2026-10-11T12:00:00+00:00")


class Route(unittest.TestCase):
    def test_field_with_mocked_network(self):
        tmp = Path(tempfile.mkdtemp(prefix="wind-"))

        class Resp:
            def __init__(self, status, text="", content=b""):
                self.status_code, self.text, self.content = status, text, content

        class C:
            def __init__(self, *a, **k):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return False

            async def head(self, url):
                return Resp(200)

            async def get(self, url, headers=None):
                if url.endswith(".idx"):
                    return Resp(200, text=IDX)
                return Resp(206, content=b"GRIB-bytes")

        fake_vals = [1.5] * 16
        with mock.patch.object(windfield, "DATA", tmp), mock.patch.object(windfield.httpx, "AsyncClient", C), \
                mock.patch.object(windfield, "decode", lambda grib: (fake_vals, 4, 4)), \
                mock.patch.dict(windfield._run_cache, {"at": 0.0, "run": None}):
            r = client.get("/api/earth/wind/meta")
            self.assertEqual(r.status_code, 200)
            self.assertIn("wind10", r.json()["products"])
            r = client.get("/api/earth/wind/wind10/3.bin")
            self.assertEqual(r.status_code, 200, r.text)
            blob = r.content
            self.assertEqual(blob[:4], b"SBWF")
            n = struct.unpack("<I", blob[4:8])[0]
            h = json.loads(blob[8:8 + n])
            self.assertEqual((h["nx"], h["ny"], h["hour"]), (2, 2, 3))
            self.assertEqual([p["name"] for p in h["planes"]], ["u", "v"])
            self.assertEqual(len(blob) - 8 - n, 2 * 2 * 2 * 2)  # two planes × 2×2 × int16
            self.assertEqual(struct.unpack("<h", blob[8 + n:10 + n])[0], 150)
            self.assertEqual(client.get("/api/earth/wind/wind10/4.bin").status_code, 404)  # not a 3-hourly step
            self.assertEqual(client.get("/api/earth/wind/nope/0.bin").status_code, 404)
            # second call comes from disk (no network): swap the client for one that fails
            with mock.patch.object(windfield.httpx, "AsyncClient", side_effect=AssertionError("no network")):
                self.assertEqual(client.get("/api/earth/wind/wind10/3.bin").status_code, 200)


if __name__ == "__main__":
    unittest.main()
