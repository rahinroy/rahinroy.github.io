'use strict';

// ── Firebase Remote Config bootstrap (cached 7 days) ──
async function loadRemoteConfig() {
  try {
    const cached = localStorage.getItem(RC_CACHE_KEY);
    if (cached) {
      const { ts, entries } = JSON.parse(cached);
      if (Date.now() - ts < RC_CACHE_TTL) {
        console.log('[RC] using cache');
        return entries;
      }
    }
  } catch {}

  console.log('[RC] fetching fresh');

  const fidBytes = crypto.getRandomValues(new Uint8Array(17));
  let fid = btoa(String.fromCharCode(...fidBytes))
    .replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c]))
    .slice(0, 22);
  fid = 'f' + fid.slice(1);

  const installResp = await fetch(
    `https://firebaseinstallations.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/installations`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GOOGLE_API_KEY,
        'X-Android-Package': ANDROID_PKG,
        'x-firebase-client': 'fire-android-installations/18.0.0',
      },
      body: JSON.stringify({
        fid,
        authVersion: 'FIS_v2',
        appId: FIREBASE_APP_ID,
        sdkVersion: 'a:18.0.0',
      }),
    }
  );

  if (!installResp.ok) throw new Error(`Firebase install failed: ${installResp.status}`);
  const installData = await installResp.json();
  const authToken = installData.authToken.token;

  const rcResp = await fetch(
    `https://firebaseremoteconfig.googleapis.com/v1/projects/${FIREBASE_PROJECT_NUM}/namespaces/firebase:fetch`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GOOGLE_API_KEY,
        'x-goog-firebase-installations-auth': authToken,
      },
      body: JSON.stringify({
        platformVersion: '33',
        appId: FIREBASE_APP_ID,
        appInstanceId: fid,
        appInstanceIdToken: authToken,
        languageCode: 'en-AU',
        timeZone: 'Australia/Perth',
        appBuild: APP_BUILD,
        appVersion: APP_VERSION,
        packageName: ANDROID_PKG,
        sdkVersion: '21.10.0',
        analyticsUserProperties: {},
      }),
    }
  );

  if (!rcResp.ok) throw new Error(`Remote Config fetch failed: ${rcResp.status}`);
  const rcData = await rcResp.json();
  const entries = rcData.entries || {};

  try {
    localStorage.setItem(RC_CACHE_KEY, JSON.stringify({ ts: Date.now(), entries }));
  } catch {}

  console.log('[RC] got key:', entries.api_key_realtime);
  return entries;
}

// ── Realtime auth header (SHA1 + nonce) ──
function sha1Base64(str) {
  const hash = CryptoJS.SHA1(str);
  const words = hash.words;
  const sigBytes = hash.sigBytes;
  const bytes = [];
  for (let i = 0; i < sigBytes; i++) {
    bytes.push((words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff);
  }
  return btoa(String.fromCharCode(...bytes));
}

function buildAuthHeader(realtimeKey) {
  const keyNoDash = realtimeKey.replace(/-/g, '');
  const ts = perthDDMMYYYYHHmmss();
  const rand6 = Array.from({ length: 6 }, () => Math.floor(Math.random() * 10)).join('');
  const base64Nonce = btoa(`${rand6}-${ts}`);
  const base64Token = sha1Base64(`${REALTIME_SECRET}-${keyNoDash}-${ts}`);
  return `Custom Username=${REALTIME_USERNAME},Nonce=${base64Nonce},Token=${base64Token}`;
}

// ── Pelias auth URL builder ──
function peliasUrl(path, params) {
  const hexTime = Math.round(Date.now() / 1000).toString(16).toUpperCase();
  const md5 = CryptoJS.MD5(PELIAS_SECRET + hexTime).toString();
  const base = `${PELIAS_BASE}${md5}/${hexTime}/${path}`;
  const qs = new URLSearchParams(params).toString();
  return qs ? `${base}?${qs}` : base;
}

// ── Pelias stop discovery ──
// Uses /suggest with numeric prefixes to find nearby stops.
// (/reverse would be more efficient but lacks CORS headers)
async function findNearbyStops(lat, lon) {
  const allStops = [];
  const seen = new Set();

  function addStop(f) {
    const props = f.properties || {};
    const label = props.label || '';
    if (!/^\d{5}\s/.test(label)) return;
    const stopUidRaw = props.StopUid || '';
    const uid = stopUidRaw.replace(/^PerthRestricted:/, '');
    if (!uid || seen.has(uid)) return;
    seen.add(uid);
    const [flon, flat] = f.geometry?.coordinates || [lon, lat];
    const dist = haversineM(lat, lon, flat, flon);
    if (dist > STOP_RADIUS_M) return;
    const publicNum = props.Code || (label.match(/^(\d{5})/) || [])[1] || '';
    const modes = (props.SupportedModes || '').toLowerCase();
    allStops.push({
      uid,
      publicNumber: publicNum,
      name: props.Description || label.replace(/^\d{5}\s*/, '').trim(),
      lat: flat,
      lon: flon,
      dist,
      modes,
    });
  }

  for (const prefix of PELIAS_PREFIXES) {
    try {
      const url = peliasUrl('suggest', {
        text: prefix,
        size: '10',
        layers: 'stops',
        'focus.point.lat': lat,
        'focus.point.lon': lon,
      });
      const resp = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!resp.ok) continue;
      const data = await resp.json();
      (data.features || []).forEach(addStop);
    } catch {}
  }

  if (allStops.length === 0) throw new Error('No nearby stops found via Pelias');

  allStops.sort((a, b) => a.dist - b.dist);
  return allStops.slice(0, MAX_STOPS_DISPLAY);
}

// ── SJP API calls ──
async function getArrivals(stopUid, realtimeKey, stopPath) {
  const path = stopPath || '/SJP/Stop';
  const resp = await fetch(`${REALTIME_BASE}/api/proxy?p=${encodeURIComponent(path)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: buildAuthHeader(realtimeKey),
    },
    body: JSON.stringify({
      StopUid: String(stopUid),
      Time: perthNowStr(),
      TransportModes: 'Bus;School Bus;Rail;Ferry',
      ReturnNotes: true,
      IsRealTimeChecked: true,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`${path} ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

async function getTrip(tripUid, tripDate, realtimeKey) {
  const path = '/SJP/Trip';
  const resp = await fetch(`${REALTIME_BASE}/api/proxy?p=${encodeURIComponent(path)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: buildAuthHeader(realtimeKey),
    },
    body: JSON.stringify({
      TripUid: String(tripUid),
      TripDate: tripDate,
      IsRealTimeChecked: true,
      ReturnNotes: true,
      IsMappingDataReturned: true,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`${path} ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

async function getTripUpdate(tripUid, tripDate, realtimeKey) {
  const path = '/SJP/Trip';
  const resp = await fetch(`${REALTIME_BASE}/api/proxy?p=${encodeURIComponent(path)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: buildAuthHeader(realtimeKey),
    },
    body: JSON.stringify({
      TripUid: String(tripUid),
      TripDate: tripDate,
      IsRealTimeChecked: true,
      UpdateOnly: true,
    }),
  });
  if (!resp.ok) return null;
  return resp.json();
}
