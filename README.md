# NBPD UAS Pre-Flight

A static, read-only pre-flight page for New Brunswick (NJ) Police Department drone pilots. It's built for phones, needs no login, and is hosted on GitHub Pages.

A scheduled GitHub Action fetches TFRs, METAR/TAF, the NWS forecast and alerts, and the planetary Kp index every 10 minutes. It applies the thresholds in `config.json` and deploys `data.json` together with the page. The page re-polls `data.json` every 5 minutes. It computes sunrise, sunset and civil twilight in the browser.

> Situational awareness aid only. The remote pilot in command remains responsible for the preflight assessment under 14 CFR 107.49 and for checking official FAA sources.

## Setup

1. **Enable Pages with GitHub Actions as the source.** Go to *Settings → Pages → Build and deployment → Source* and choose **GitHub Actions**.
2. **Set the NWS contact variable.** Go to *Settings → Secrets and variables → Actions → Variables → New repository variable* and add `NWS_CONTACT`. Set it to an email address or URL where NWS can reach the page's maintainer, for example `uas-unit@example.org`. The NWS API requires an identifying User-Agent, which is sent as `(nbpd-uas-preflight, <NWS_CONTACT>)`.
3. **Run the workflow once.** Go to *Actions → Refresh pre-flight data → Run workflow*. After that it runs every 10 minutes and on every push to `main`. The page URL appears on the run summary.
4. **Check the deployment.** Open the page, expand **Data source status** at the bottom, and confirm that every source shows ✅.

The workflow never commits to the repository. Each run builds a new Pages deployment with a fresh `data.json`.

Note: GitHub sometimes delays scheduled workflows by several minutes or more when it is under load. When that happens, the page shows **DATA STALE** once `data.json` is more than 30 minutes old.

## Vercel deployment (this branch): any US ZIP code

This branch runs on Vercel (dfrpreflight.com), side by side with the GitHub Pages site on `main`.

- `/` shows a ZIP form. `/08901` shows the pre-flight page for that ZIP; `/08901/` redirects there.
- **Use my location** (on the form and on every location page) asks the browser for the device's position and opens `/?lat=40.512&lon=-74.406` (3 decimals, about 100 m). Distances are then measured from that point, not a ZIP centre. The nearest ZIP supplies the state for the TFR filter and the "Near Edison, NJ" label; a point more than 50 NM from every US ZIP centre is refused as outside coverage.
- The page loads `/api/data?zip=08901` (or `/api/data?lat=…&lon=…`). The function `api/data.mjs` looks the ZIP up in `data/zips.json`, builds that location's config (`scripts/location.mjs`) and runs `scripts/fetch.mjs` on demand. An unknown ZIP returns 404 and the page shows the form again.
- Vercel's CDN caches each ZIP's result for 5 minutes and serves a stale copy for up to 10 more while it refreshes, so data is at most about 15 minutes old, under the 30-minute DATA STALE limit. The TFR list, TFR details and Kp are the same for every ZIP, so a warm function instance shares them across ZIPs for 5 minutes.
- `?data=samples/…` still previews the sample files, and `/data.json` still serves the fixed `config.json` location.

What changes per ZIP:

| | Fixed config (`config.json`) | ZIP page |
| --- | --- | --- |
| Centre | `center` | ZIP centre point from GeoNames (not the flight location; large rural ZIPs can be several NM across), or the device location |
| TFR states | `tfrStates` | the (nearest) ZIP's state plus bordering states |
| METAR / TAF | `stations`, `tafStations` | nearest `stationCount` (3) METAR and `tafCount` (2) TAF stations within `stationSearchNm` (60 NM), from an aviationweather.gov bounding-box query; no station in range is a CAUTION |
| Time zone | `timeZone` | from the NWS point lookup, else the device's zone |

Thresholds, TFR radius and everything else come from `config.json` for every ZIP.

`data/zips.json` (about 41,000 ZIPs; territories and military APO/FPO codes are not included) is built from the GeoNames US postal-code file (CC BY 4.0; credited in the page footer). To refresh it:

```sh
curl -O https://download.geonames.org/export/zip/US.zip && unzip US.zip US.txt
node scripts/build-zips.mjs US.txt
```

Setup: import the repository in Vercel (framework preset **Other**, no build command), add the `NWS_CONTACT` environment variable, and set the production branch to this branch.

## Editing `config.json`

| Key | Meaning |
| --- | --- |
| `center.lat`, `center.lon` | Reference point for TFR distances, NWS forecast/alerts and sun times. Default: 40.4862, -74.4518. |
| `tfrRadiusNm` | Local TFRs farther than this are dropped. Default: 30. |
| `tfrStates` | FAA list `state` values checked for local TFRs. |
| `stations` | METAR stations, listed in display order. |
| `tafStations` | Stations to request TAFs for (only airports that issue one; KSMQ does not). Defaults to `stations`. |
| `forecastHours` | Number of hourly forecast rows shown. |
| `staleMinutes` | Age after which the page shows DATA STALE. |
| `thresholds` | Caution and no-go-review limits (see below). |
| `airspaceRadiusNm` | Radius for the airspace card and map (restricted areas, nearest controlled airspace). Default: 3. |
| `thresholds.airspace` | `controlledLevel` (1 = CAUTION) inside controlled airspace; `zeroCeilingLevel` (2 = NO-GO REVIEW) on a 0 ft facility map ceiling; `nearNm` (0.5) for "near a restricted area"; `stadiumLevel` (0 = information only). Agencies flying under a COA can lower these. |
| `tfrDetailXmlUrls` | Per-TFR XML URL patterns, tried in order. `{id}` becomes `6_1234` for NOTAM `6/1234`. Edit these if the FAA moves the files. |

Commit a change to `config.json` on `main` and the workflow redeploys automatically.

### Thresholds

| Condition | CAUTION | NO-GO REVIEW |
| --- | --- | --- |
| Wind (METAR) | ≥ 15 kt | ≥ 20 kt |
| Gust (METAR) | ≥ 20 kt | ≥ 25 kt |
| Visibility | < 5 SM | < 3 SM |
| Ceiling (lowest BKN/OVC/VV) | < 1500 ft AGL | < 900 ft AGL |
| Precipitation | forecast > 30% | precip/thunderstorm in a METAR now |
| Kp | ≥ 4 | ≥ 5 |
| TFR | within `tfrRadiusNm`, or distance unknown | within 5 NM, or covering the point |
| NWS alert | Advisory | Watch or Warning |
| Airspace | controlled airspace below 400 ft AGL (authorization needed); within 0.5 NM of a prohibited/restricted area or 99.7 restriction; DC SFRA | 0 ft facility map ceiling; inside a prohibited or restricted area, a 99.7 national security restriction, national defense airspace, or the DC FRZ |

How the thresholds are applied:

- **Worst condition wins.** The banner shows the highest level found anywhere on the page.
- **METAR thresholds apply to every listed station.** The banner and the station card both name the station that triggered a flag.
- **Forecast hours can raise the banner only to CAUTION.** Wind, gust and precipitation in the next 6 hours are flagged, but forecast values never trigger NO-GO REVIEW on their own.
- **Missing data is never GO.**
  - If any source fails, the banner shows at least CAUTION, and that section says to check the official source.
  - If `data.json` is more than 30 minutes old, the page shows DATA STALE and raises the banner to at least CAUTION.
  - A METAR older than 90 minutes (`metarMaxAgeMin`) is flagged CAUTION.
- **TFR timing doesn't change the level.** Each TFR shows **ACTIVE NOW**, **STARTS IN …** (highlighted when it starts within 3 hours), **ENDED … ago** or **TIMES UNKNOWN**. The status is computed in the browser, so it stays current between refreshes. Upcoming and ended TFRs still raise the banner, because the FAA list is the source of truth and the time parsing can't be checked against every TFR format.
- **Airspace is judged at the point, for flight up to 400 ft AGL.** Class B/C/D/E counts as controlled only where its floor is below 400 ft AGL; MSL floors are converted with the ground elevation from the NWS grid (unknown elevation is CAUTION, never assumed clear). Class E from 700/1,200 ft AGL and Mode C veils don't count. MOAs, warning and alert areas, and stadiums (the FDC 4/3621 event TFR is only active around games) are shown for information. The DC FRZ and SFRA aren't in the FAA layers, so they're approximated as 15 and 30 NM circles around DCA.
- **The page adds a note outside sunrise to sunset.** During civil twilight or at night it reminds the pilot that anti-collision lighting is required (14 CFR 107.29). This note does not change the banner.

## Page layout

The **Map** card (Leaflet, loaded only when opened; street map or FAA VFR sectional) shows the point, the TFR radius, TFR shapes, the LAANC facility map grid colour-coded by ceiling (numbers appear when zoomed in), controlled airspace, restricted areas, stadiums and METAR stations. It remembers whether it was open.

Each information card (TFRs, Airspace & LAANC, METAR, Next 6 hours, NWS alerts, Kp & daylight) starts collapsed. It shows only its title and what it contributes to the banner: GO, CAUTION, NO-GO REVIEW, or UNAVAILABLE when that card's source failed. Tap a card to open it. Cards stay open across the 5-minute refreshes. The official-source links are always shown.

## Data sources (all keyless)

| Source | Endpoint |
| --- | --- |
| FAA TFR list | `https://tfr.faa.gov/tfrapi/exportTfrList` |
| FAA TFR detail | `https://tfr.faa.gov/download/detail_{id}.xml`, with the older `save_pages/` path as a fallback |
| METAR / TAF | `https://aviationweather.gov/api/data/{metar,taf}?ids=…&format=json` |
| NWS | `/points/{lat},{lon}`, then `forecastHourly` and `forecastGridData` (for gusts), plus `/alerts/active?point=` |
| Kp | `https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json` |
| FAA airspace | UAS Data Delivery System layers on `https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/…/FeatureServer/0/query` (one envelope query each): `FAA_UAS_FacilityMap_Data`, `Class_Airspace`, `Special_Use_Airspace`, `DoD_Mar_13` (99.7 restrictions), `Part_Time_National_Security_UAS_Flight_Restrictions`, `National_Defense_Airspace_TFR_Areas`, `Stadiums`. ArcGIS reports query errors with HTTP 200; those fail the source. |
| Map tiles (browser) | `tile.openstreetmap.org` (light use, attribution required) and the FAA `VFR_Sectional` tile service |

How TFRs are filtered:

- **Local:** TFRs whose `state` is NJ, NY or PA. Each one's XML is parsed for its circle or polygon (arcs included) and its altitudes.
- **Standing national restrictions:** TFRs with `facility` FDC or `state` USA. These appear in a collapsed group and do not affect the banner.
- **Unparseable geometry:** if a TFR's XML can't be fetched or its geometry can't be read, the TFR is kept and marked "distance unknown — check FAA" (CAUTION).

## Local development

You need Node 20 or later. There are no dependencies.

```sh
node scripts/fetch.mjs              # live fetch -> data.json (set NWS_CONTACT first)
python3 -m http.server 8000         # then open http://localhost:8000/?data=data.json
```

You can preview the bundled samples without network access:

- `http://localhost:8000/?data=samples/data-caution.json`: all sources OK, CAUTION
- `?data=samples/data-nogo.json`: NO-GO REVIEW (nearby VIP TFR, thunderstorm, Kp 5.33)
- `?data=samples/data-stale.json`: data 47 minutes old, shows DATA STALE
- `?data=samples/data-partial.json`: NWS forecast, Kp and TFR-detail fetches failed

The samples also work on the deployed site at `/<repo>/?data=samples/…`. They are marked **SAMPLE DATA — NOT LIVE**.

To run the tests and rebuild the samples:

```sh
node test/test.mjs                  # parser + pipeline checks (offline)
npm run samples                     # regenerate test/fixtures/* and samples/*
```

`fetch.mjs` also takes these options:

- `--fixtures dirA,dirB`: read raw responses from files instead of the network. The first directory with a matching file wins.
- `--fail kp,nws_points`: simulate an outage of those sources.
- `--now <ISO>`: run as if it were that time.
- `--sample-age <min>`: mark the output as sample data that is `<min>` minutes old.
- `--out <file>`: write somewhere other than `data.json`.

The fixtures in `test/fixtures/` are synthetic. They follow each API's response format, but every value in them is invented.

## Files

```
index.html  app.js  suncalc.js   page (vanilla JS/CSS, no build, no CDN)
config.json                      hand-edited settings
scripts/fetch.mjs                fetch + filter + thresholds -> data.json
scripts/airspace.mjs  geo.mjs    FAA airspace layers -> airspace verdict + map data; shared geometry
vendor/leaflet/                  Leaflet 1.9.4 (BSD-2-Clause), loaded by the map card
.github/workflows/refresh.yml    cron every 10 min + manual run -> GitHub Pages
api/data.mjs  vercel.json         Vercel: /NNNNN routing, on-demand data per ZIP behind the CDN cache
scripts/location.mjs  data/zips.json  ZIP -> location config; scripts/build-zips.mjs rebuilds the data
samples/  test/                  sample data.json files, fixtures, tests
```
