# Transperth Live — Project Context

## What this is

A real-time transit tracker for Perth, Western Australia. Shows live bus/train/ferry positions, ETAs, and route polylines on a dark-themed Leaflet map. Built as a single-file HTML/CSS/JS app — no build step, no framework.

Deployed at `rahinroy.github.io/projects/transperth/transperth.html`.

## Architecture

```
transperth.html          Single-file app (HTML + CSS + JS, ~1550 lines)
vercel-proxy/
  api/proxy.js           Vercel Edge Function — CORS proxy to realtime.transperth.info
  vercel.json            Empty config (no rewrites needed)
TRANSPERTH_API.md        Full reverse-engineered API reference
serve.py                 Local dev server (python)
```

### Why a single file

The entire app is one `.html` file. No bundler, no framework, no npm. Keep it that way. External deps are loaded via CDN (`<script>` / `<link>` tags): Leaflet for the map, CryptoJS for HMAC auth.

### CORS proxy

Browser requests to `realtime.transperth.info` are blocked by CORS. All API calls go through a Vercel Edge Function at `https://rahinroy-github-io.vercel.app/api/proxy?p=/SJP/Stop`.

The proxy is at `vercel-proxy/api/proxy.js`. It forwards POST requests, passing through the Authorization header and body. It adds `User-Agent: okhttp/4.12.0` to mimic the Android app.

**Important history**: We originally used a Cloudflare Worker, but Cloudflare's data center IPs got blocked by the F5 BigIP load balancer in front of `realtime.transperth.info`. Vercel's edge IPs are not blocked (as of April 2026). If Vercel starts getting blocked too, the fix is finding another edge provider whose IPs aren't on the F5 blocklist — the API itself is fine, it's an IP-level block.

### API calls use `?p=` query param

The frontend calls the proxy like:
```javascript
fetch(`${REALTIME_BASE}/api/proxy?p=${encodeURIComponent('/SJP/Stop')}`, { ... })
```
The proxy reads the `p` param and forwards to `https://realtime.transperth.info` + that path.

## Backend API

Full details in `TRANSPERTH_API.md`. Quick summary:

### Auth flow
1. Bootstrap Firebase Remote Config (anonymous, two HTTP calls) to get `api_key_realtime`
2. Cache the key for 7 days in localStorage (`tp_rc_cache`)
3. Build per-request `Authorization: Custom Username=PhoneApp,Nonce=...,Token=...` header using HMAC-style scheme with `TrAnSpErTh` shared secret + the runtime key
4. Timestamp must be in **Perth local time** (UTC+8), format `DDMMYYYYHHmmss`

### Endpoints
- **`/SJP/Stop`** — arrivals at a stop (live bus positions, ETAs, 120-min window)
- **`/SJP/Trip`** — full trip detail (every stop, route polyline, GPS position)
- **Pelias geocoder** (`pelias.transperth.info`) — stop discovery by name/location. Different auth (MD5-based URL path, no header).

### Polyline format
The polyline from `/SJP/Trip` (`Summary.Polyline`) is semicolon-separated `lat, lon` pairs:
```
-32.012348, 115.9439978;-32.0115967, 115.9432389;...
```
Split on `;`, then split each pair on `,` with trim. It is NOT Google encoded polyline (though a decoder for that is included as fallback).

## Frontend design

### Visual style
- Dark theme (CSS variables: `--bg: #0f0f12`, `--surface: #1c1c22`, etc.)
- Carto dark tiles for the map
- Color-coded by mode: bus = blue, rail = orange, ferry = purple
- Live indicator: green pulsing dot in header

### Layout
- **Desktop**: sidebar (380px) + map. Sidebar has stop tabs at top, arrival rows below.
- **Mobile** (< 700px): map fills screen, sidebar becomes a bottom sheet overlay with drag handle. Collapsed state shows header only (52px), expanded shows stops + arrivals (max 70dvh). Touch targets are 44px minimum.

### Map behavior
- Center crosshair dot (white circle, `z-index: 500`, `pointer-events: none`) shows map center
- On pan: after 800ms debounce + 200m movement threshold, nearby stops refresh automatically via `loadStopsAtCenter()`
- User location marker has "You are here" tooltip
- Stop markers are cyan circles with permanent labels
- Bus position markers show fleet number + route, rotate by bearing
- Route polylines are blue (#4f9cf9, 4px, 0.8 opacity) with circle markers at each stop

### Perth fallback
If geolocation is denied or the user is outside greater Perth (rough bounding box: lat -32.6 to -31.3, lon 115.4 to 116.3), the app defaults to Perth CBD (-31.9505, 115.8605). The app still works — just centered on the city instead of the user.

### Route overlay
- Click an arrival row → fetches `/SJP/Trip` → draws polyline + stop dots on map
- Click same row again → toggles off (clears overlay)
- Click different arrival → clears previous, draws new
- Map fits to show entire route
- Stop dots are colored: green for passed stops (status 3), orange for upcoming (status 1)

### Auto-refresh
- Arrivals auto-refresh every 15 seconds
- Polling uses `setInterval` with the stop's active UID

## Key state

All mutable state lives in a `state` object:
```javascript
state = {
  realtimeKey,           // from Firebase Remote Config
  userLat, userLon,      // user geolocation (null if unavailable)
  stops: [],             // nearby stops from Pelias
  activeStopUid,         // currently selected stop tab
  arrivals: {},          // { stopUid: tripsArray }
  stopMarkers: [],       // Leaflet markers for stops
  busMarkers: {},        // Leaflet markers for live buses
  userMarker,            // Leaflet marker for user location
  activeRoute: null,     // { polyline, stopMarkers, tripUid } for route overlay
}
```

## Development workflow

### Local testing
```bash
python3 serve.py
# or just open transperth.html directly in a browser
```

### Deploying
The app is hosted on GitHub Pages. Push to `master` branch to deploy:
```bash
git add projects/transperth/transperth.html
git commit -m "description"
git push
```

The Vercel proxy deploys automatically from the same repo (connected to Vercel via GitHub integration). The proxy files are in `vercel-proxy/`.

### Do not commit/push without user approval
The project has no automated tests. All changes must be manually validated by the user before committing. Wait for explicit instruction to commit/push.

## Common pitfalls

- **API returning 404**: Likely the CORS proxy's edge IPs are being blocked by F5 BigIP, not an API change. The API is stable. Test by curling directly from a residential IP to confirm. Don't assume the API is down or changed.
- **Polyline rendering as a vertical line**: The coordinate parser is splitting wrong. The format is `lat, lon;lat, lon` — split on `;` only, not on spaces.
- **Auth returning 403**: Check timestamp is Perth local time (UTC+8), key is from Remote Config (not the stale BuildConfig fallback), and the SHA1 input format is `TrAnSpErTh-<keyNoDashes>-<timestamp>`.
- **Firebase Remote Config key rotation**: The `api_key_realtime` can rotate. The app caches it for 7 days. If auth starts failing, clear the cache and re-bootstrap.

## Design principles (from user)

- **Keep it simple**: single HTML file, no build tools, no frameworks
- **Mobile-first**: must work well as a mobile web app on anyone's device
- **Publicly accessible**: no user accounts, no API keys exposed to end users, proxy handles auth
- **Don't over-engineer**: avoid abstractions for one-time operations, don't add features beyond what's asked
- **Don't assume API changes**: if something breaks, suspect the proxy/network layer first, not the upstream API
