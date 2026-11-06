# SkyScout

Cloud, weather and night-sky forecaster with a 3D sky preview. It runs in any modern browser (desktop and iPhone) as a static web app, with no build step.

## Run it on this PC

```
node tools/serve.js 8133
```

Then open http://localhost:8133. From the Claude app, the `skyscout` entry in `D:\Claude\.claude\launch.json` starts the same server.

## Put it on your iPhone

Location, the compass "look with phone" mode and offline use need **HTTPS**, so the app needs a real web address:

1. Upload the whole `skyscout` folder to any static host, for example Netlify Drop, GitHub Pages or Cloudflare Pages. The folder is the whole site; there is nothing to build.
2. Open the address in Safari on the iPhone, then tap **Share → Add to Home Screen**. It opens full-screen like an app.
3. After one online visit, the app keeps working offline. It shows the last forecast, satellite, terrain and map data it saved, with an "offline" banner.

On the same Wi-Fi you can also open `http://<this PC's IP>:8133` on the phone. That works for viewing, but without HTTPS Safari blocks location, the compass and offline caching.

## What it does

- **Map**: live geostationary infrared clouds (GOES-East/West and Himawari, colour-coded by cloud-top temperature), GOES GeoColor, live radar (RainViewer), NASA Black Marble night lights, a 3-model cloud forecast overlay for the slider time, and live traffic (TomTom key, optional).
- **Conditions**: 7 weather models (ECMWF, GFS/HRRR, ICON, GEM, UKMO, Météo-France, JMA) are averaged, and their spread is shown. The panel covers cloud layers and types, fog risk, transparency (CAMS aerosol), seeing (jet stream), snow on the ground, road hazards, Moon and twilight times, and moon-free dark windows.
- **Light pollution**: a whole-sky scattering model (Rayleigh and aerosol single scattering on a curved Earth, Garstang city emission) fed by VIIRS night lights within about 280 km. It gives zenith brightness, Bortle class and naked-eye limit, plus a polar map of horizon glow with the cities causing each dome. Snow cover brightens it, and clouds light up over cities.
- **3D view** (full 360°, drag or use the phone's motion sensors):
  - Physically based sky: sunset colours, Earth's shadow, blue hour, and civil, nautical and astronomical twilight.
  - Real star positions (Hipparcos), planets, and the Moon with its true phase. Stars, the Milky Way and planets fade with light pollution, moonlight and haze; atmospheric extinction and twinkling are included.
  - Volumetric clouds placed at model or satellite heights: cumulus, stratocumulus, stratus and fog, altocumulus and altostratus, cirrus, and cumulonimbus with anvils and rain shafts. Clouds are lit by the Sun, the Moon, city light from below and lightning.
  - Real terrain out to about 180 km with Earth curvature, aerial photo ground, snow cover and wet ground. Procedural grass is the only invented detail.
  - Optional "Load buildings…": OpenStreetMap buildings with realistic roofs and lit windows, trees and forests (each tree follows its own seasonal leaf cycle), street lamps and light pools, power lines with sagging wires, wind turbines and masts with aviation lights, roads with moving car lights, and farm fields planted with the likely regional crop at the right stage of its calendar.
  - Rain, snow, lightning with thunder, distant storms on the horizon, and simulated red sprites.
  - Overlays: alt/az grid, cardinal points, meridian, ecliptic, celestial equator, constellations, labels and light domes.
- **Best spots**: scores up to about 130 sites within your drive time. It weighs clouds (3 models, spread penalised), darkness at the zenith and the horizon, fog, transparency, seeing, snow and road hazards, and drive time with typical traffic for the hour (or live TomTom traffic). The route is coloured by expected congestion.
- **Sprite finder**: forecasts storm systems (MCS) over about ±840 km and finds viewing spots 120–600 km away with a clear line of sight above the storm, the Moon down and less light pollution in that direction.

## Notes

- All data is free and needs no key, except optional TomTom traffic. The free Open-Meteo tier allows roughly 10,000 calls a day. A full scout or sprite search uses a few hundred to about a thousand, and results are cached for about 45 minutes.
- No geostationary infrared layer exists for Europe and Africa on NASA GIBS, so clouds there come from the models only.
- Light pollution is calibrated against known sky-quality readings. Expect about ±0.5 mag/arcsec² error.

`tools/prepdata.js` rebuilds `data/` from the raw catalogues. `tools/icons.js` draws the app icons.
