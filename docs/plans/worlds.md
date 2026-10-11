# Worlds: feature map and roadmap

Written 2026-10-11 after the Atlas integration batch. The yardstick is Google Earth (Pro and web): what it has, what
Shell:B's Worlds has, and what is worth building next on a local-first machine with a 139 GB OSM planet, USGS mosaics for
21 other worlds, elevation for four of them, an offline Wikipedia, a GPU and an agent that can research.

## Where Worlds stands against Google Earth

| Google Earth feature | Worlds today | Notes |
|---|---|---|
| 3D globe, flat map, tilt and rotate | Yes (MapLibre globe projection) | Every world, not just Earth |
| Satellite imagery basemap | Yes: NASA GIBS daily MODIS/VIIRS, Blue Marble, night lights (online, cached) | Not sub-metre imagery: GIBS tops out at ~250 m/px. Street-level detail comes from the OSM vector map |
| Historical imagery slider | Yes, by day since 2000 through the map clock | Google's goes back further in places with aerial photos; ours is global and daily |
| 3D terrain | Yes (Earth, Mars, Moon, Mercury) | Exaggeration scaled by the world's radius |
| 3D buildings | Yes, OSM heights (box extrusions) | No photogrammetry meshes; those are Google's proprietary data |
| Street View | No | See Panoramax below |
| Voyager stories / guided tours | Yes: Atlas-authored tours with narration and voice | Google's are hand-made; ours are made on request |
| Measure distance and area | Distance and elevation profile yes; area no | Area/polygon measure is a small addition |
| Elevation profile | Yes, from the DEM tiles | |
| Placemarks, paths, projects | Bookmarks + Atlas places (with full cards) | Drawing paths by hand is not done (import GPX/KML instead) |
| KML/KMZ import and export | GeoJSON/KML/GPX import, KML/GeoJSON export | KMZ (zipped, with images) not yet |
| Photos layer | No | Wikimedia Commons geosearch would do it (online) |
| Weather: clouds, radar | Satellite precipitation (IMERG, hours behind) yes; clouds come with the daily imagery | True ground radar has no free global feed; RainViewer's tiles stopped answering |
| Sun and shadows | Day & night terminator yes; building shadows no | MapLibre has no shadow casting yet |
| Ocean floor, dive below the surface | Bathymetry tint and relief yes; diving no | See "Dive view" below |
| Moon, Mars, Sky modes | 21 worlds, orrery, local sky view, spacecraft | Beyond Google Earth here |
| Flight simulator | No | Could be built on the terrain (see below) |
| Timelapse (yearly, 1984 to now) | No | Google Earth Engine product; Landsat annual composites exist on GIBS only for some years |
| Wikipedia layer | Offline wiki app, but no "articles near here" layer | The maxi ZIM has no geo index; see below |

## Shipped in this batch (2026-10-11)

- Atlas drives the app: scene keys in map blocks (pitch, bearing, layers, time, years_ago, focus, model, tour), applied
  live by the copilot and by "Open in Maps"; context line carries the open card of any kind, layers, clock, pin, flight.
- Cards: `read_map_card`, `remove` on `annotate_map_feature`, GLB media, Atlas places (new points with cards).
- 3D models: 51 NASA GLBs with a catalog mapping them to landmarks, spacecraft and worlds; viewer in cards, lightbox,
  gallery tab; `model` key for Atlas.
- Layers: satellite imagery (GIBS, follows the clock), rain & snow (GPM IMERG via GIBS), 3D buildings (OSM heights), Atlas places.
- Interiors: cross-sections for the Sun, planets and major moons in the dossier.
- Tours with narration and TTS; measure elevation profile; GeoJSON/KML/GPX import, KML/GeoJSON export.

## Explored, worth building next

### Dive view (underwater 3D)
MapLibre's camera cannot go below the terrain, so "diving" to the Titanic needs its own renderer. The pieces exist: the
Earth DEM includes GEBCO/ETOPO bathymetry, three.js is already in the bundle, and `elevation.ts` decodes terrarium tiles
in the browser. Plan: a `DiveView` component that fetches a 64 x 64 grid of heights around a point (z 8 to 10, 20 to
200 km across), builds a `PlaneGeometry` mesh with depth-tinted vertex colours, adds fog and a blue gradient sky, places
a wreck marker (or a GLB model when one exists) at the seabed, and lets the user orbit and fly. Entry points: a "Dive
here" button on shipwreck cards and on the pin when the pin is at sea; Atlas via a `dive: {lat, lon}` scene key.
Effort: about a day. Same component gives "fly-through" views of canyons (Valles Marineris) with the Mars DEM.

### Procedural worlds (exoplanets)
A MapLibre custom protocol (`proc://seed/{z}/{x}/{y}`) can render raster tiles on the fly in a Web Worker from layered
simplex noise (continents, mountains, ice caps, oceans) seeded per world, with a matching terrarium DEM so relief and 3D
terrain work unchanged. Worlds list: confirmed exoplanets (TRAPPIST-1 e, Proxima b, Kepler-452 b, LHS 1140 b...) with
their real radius, gravity, insolation and a dossier, surface clearly labelled "imagined, no map exists". Atlas could
tune a world ("make Proxima b a tidally locked eyeball planet": one hemisphere ice, a ring of ocean). Effort: two days
(noise worker, tile protocol, catalog entries, dossier wiring).

### Interior maps (two meanings)
- Planetary interiors: done (cross-sections). A richer next step is a tappable 3D cut-away globe in the dossier.
- Indoor maps (buildings' floors): OSM has `indoor=*` and `level=*` tags, but the Protomaps basemap drops them. Options:
  (a) an Overpass query at zoom 17+ for the visible area (online, simple, slow for big stations); (b) a planetiler
  profile that adds an `indoor` layer to our own planet build (offline, a rebuild of the planet file). Worth doing only
  if Evie wants airports/stations/museums floor by floor; (a) is an afternoon, (b) a weekend of compute.

### Street-level imagery
Mapillary needs an API token and sends every request to Meta; Panoramax (the open alternative, api.panoramax.xyz) is
free, keyless and CC-BY-SA, with 360° pictures growing fast in France and Europe. A "Street photos" layer: fetch
pictures near the view from Panoramax, show them as small camera dots, open a pannellum/three.js sphere viewer. Online
only, proxied through the server like radar. Effort: a day.

### Photos and Wikipedia nearby
- Wikimedia Commons geosearch (`action=query&list=geosearch`) gives photos around a point with licenses; a "Photos"
  layer with thumbnails, cached like imagery. Half a day.
- "Wikipedia articles here": the offline maxi ZIM has no geo index, but Wikipedia's own geosearch API (online) returns
  titles with coordinates; the titles then open offline in the Wiki app. Half a day. A fully offline version needs a
  one-time pass over the ZIM extracting `{{coord}}` templates into SQLite (a few hours of compute, ~2 M rows).

### Area measurement and hand-drawn paths
Polygon measure (spherical excess area) and a draw tool that saves paths as bookmarks/GeoJSON: small, half a day.

### Flight simulator
With 3D terrain and the globe, a simple aircraft mode (keyboard pitch/roll/throttle, camera following a point moving
over the terrain, altitude from the DEM) is feasible in MapLibre's `free camera` API. A fun weekend project; Atlas could
set up a flight ("take off from Kourou, fly along the coast").

### Live Earth extras
- NASA EONET natural events (fires, storms, volcanoes) as a layer: free JSON, an afternoon.
- GIBS has many more layers worth exposing behind the imagery picker: sea surface temperature, chlorophyll, snow cover,
  aerosols, land surface temperature. Each is one catalog line in `earthview.LAYERS`.
- Ship traffic (AIS) has no free global feed; aisstream.io needs a key. Not planned.

### Other worlds
- More DEMs: Venus (Magellan GTDR, coarse) and Ceres/Vesta (Dawn) can be built with `planets/build_dem.py`; Titan and
  Europa have none global.
- Mars HiRISE/CTX close-ups for landing sites as small high-zoom raster insets (public, a few hundred MB each).
- Spacecraft models for the Sol orrery (the probes drawn at their real positions from Horizons).
