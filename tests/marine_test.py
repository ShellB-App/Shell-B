"""Marine biology: the `marine` tool and /api/marine routes, with the public services (WoRMS, OBIS, Open-Meteo) stubbed so
the test runs offline. Checks name resolution order, OBIS summaries and their map block, sea conditions, the land case,
and that the sea layers ride on earthview's tile proxy without showing up in the imagery picker."""
import asyncio
import json
import unittest
from types import SimpleNamespace

from smoke_test import client, shellb  # noqa: F401

import earthview
import marine

FAKE = {
    "AphiaRecordsByName/grand dauphin?like=false": None,
    "AphiaRecordsByVernacular/grand dauphin?like=false": [{"AphiaID": 137111, "valid_AphiaID": 137111, "valid_name": "Tursiops truncatus",
                                                             "scientificname": "Tursiops truncatus", "rank": "Species", "status": "accepted"}],
    "AphiaRecordByAphiaID/137111": {"scientificname": "Tursiops truncatus", "valid_name": "Tursiops truncatus", "authority": "(Montagu, 1821)",
                                    "rank": "Species", "status": "accepted", "isMarine": 1, "isBrackish": 1},
    "AphiaClassificationByAphiaID/137111": {"rank": "Kingdom", "scientificname": "Animalia", "child": {"rank": "Family", "scientificname": "Delphinidae",
                                            "child": {"rank": "Species", "scientificname": "Tursiops truncatus", "child": None}}},
    "AphiaVernacularsByAphiaID/137111": [{"vernacular": "grand dauphin", "language_code": "fra"}, {"vernacular": "bottlenose dolphin", "language_code": "eng"}],
    "AphiaSynonymsByAphiaID/137111": [{"scientificname": "Delphinus truncatus"}],
    "statistics": {"records": 3, "datasets": 2, "yearrange": [1990, 2024]},
    "occurrence/grid/3": {"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[5, 43], [6, 43], [6, 44], [5, 44], [5, 43]]]}, "properties": {"n": 2}},
        {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[0, 40], [1, 40], [1, 41], [0, 41], [0, 40]]]}, "properties": {"n": 1}}]},
    "checklist": {"total": 2, "results": [{"scientificName": "Posidonia oceanica", "taxonID": 145794, "taxonRank": "Species", "kingdom": "Plantae",
                                           "family": "Posidoniaceae", "records": 50}]},
}


async def fake_get_json(url, params=None, ttl=0, timeout=0):
    if url == marine.OPEN_METEO:
        land = params["latitude"] > 45
        cur = {k: None for k in marine.CURRENT} if land else {"time": "2026-10-11T10:00", "sea_surface_temperature": 21.9, "wave_height": 1.3,
                                                               "wave_direction": 290, "wave_period": 4.7, "swell_wave_height": 0.6,
                                                               "ocean_current_velocity": 0.8, "ocean_current_direction": 160}
        return {"latitude": params["latitude"], "longitude": params["longitude"], "current": cur,
                "hourly": {"sea_surface_temperature": [21.6, 22.0]}, "daily": {"time": ["2026-10-11"], "wave_height_max": [1.4], "wave_direction_dominant": [290]}}
    path = url.split("/rest/", 1)[-1].split("/v3/", 1)[-1]
    like = (params or {}).get("like")
    key = f"{path}?like={like}" if like else path
    return FAKE.get(key)


def run(args):
    return asyncio.run(marine.marine_tool(args, SimpleNamespace(conv_id="conv-test")))


class Marine(unittest.TestCase):
    def setUp(self):
        self._orig = marine._get_json
        marine._get_json = fake_get_json

    def tearDown(self):
        marine._get_json = self._orig

    def test_common_name_resolves_to_species(self):
        r = run({"action": "species", "name": "grand dauphin", "language": "fr"})
        self.assertFalse(r.error, r.text)
        self.assertIn("Tursiops truncatus", r.text)
        self.assertIn("grand dauphin", r.text)
        self.assertIn("Delphinus truncatus", r.text)

    def test_occurrences_and_map(self):
        r = run({"action": "occurrences", "aphia": 137111})
        self.assertFalse(r.error, r.text)
        self.assertIn("3 occurrence records", r.text)
        spec = json.loads(r.text.split("```map\n", 1)[1].split("\n```", 1)[0])
        self.assertEqual(spec["markers"][0]["label"], "2 records")
        self.assertEqual(spec["markers"][1]["label"], "1 record")

    def test_checklist_and_ocean(self):
        self.assertIn("Posidonia oceanica", run({"action": "checklist", "lat": 43.2, "lon": 5.3}).text)
        sea = run({"action": "ocean", "lat": 43.15, "lon": 5.35})
        self.assertIn("21.9 °C", sea.text)
        self.assertIn("from WNW", sea.text)
        self.assertTrue(run({"action": "ocean", "lat": 48.85, "lon": 2.35}).error)
        self.assertTrue(run({"action": "ocean"}).error)

    def test_routes(self):
        r = client.get("/api/marine/ocean", params={"lat": 43.15, "lon": 5.35})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["current"]["sea_surface_temperature"], 21.9)
        self.assertEqual(client.get("/api/marine/ocean", params={"lat": 123, "lon": 0}).status_code, 400)
        self.assertEqual(client.get("/api/marine/checklist", params={"lat": 43.2, "lon": 5.3}).json()["species"][0]["name"], "Posidonia oceanica")

    def test_area_box(self):
        w = marine.area_wkt(43.0, 5.0, 111)
        self.assertTrue(w.startswith("POLYGON((") and w.count(",") == 4)
        self.assertIn("44.0000", w)

    def test_sea_layers_ride_on_earthview(self):
        ids = {l["id"] for l in earthview.imagery()["layers"]}
        self.assertTrue({"sst", "sstanom", "chl"}.isdisjoint(ids))
        self.assertEqual(earthview.clamp_date(earthview.LAYERS["sst"], "2999-01-01"), earthview.latest_date(2))


if __name__ == "__main__":
    unittest.main()
