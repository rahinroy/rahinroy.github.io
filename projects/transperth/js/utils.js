'use strict';

// ── EventBus ──
const EventBus = {
  _listeners: {},
  on(event, fn) {
    (this._listeners[event] || (this._listeners[event] = [])).push(fn);
  },
  off(event, fn) {
    const list = this._listeners[event];
    if (!list) return;
    this._listeners[event] = list.filter(f => f !== fn);
  },
  emit(event, data) {
    (this._listeners[event] || []).forEach(fn => fn(data));
  },
};

// ── Perth time helpers (always UTC+8 via Intl API) ──
const _perthFmt = new Intl.DateTimeFormat('en-AU', {
  timeZone: 'Australia/Perth',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
});

function _perthParts(d) {
  const p = {};
  _perthFmt.formatToParts(d || new Date()).forEach(({ type, value }) => { p[type] = value; });
  return p;
}

function perthNow() {
  const p = _perthParts();
  return new Date(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`);
}

function perthNowStr() {
  const p = _perthParts();
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

function perthDDMMYYYYHHmmss() {
  const p = _perthParts();
  return `${p.day}${p.month}${p.year}${p.hour}${p.minute}${p.second}`;
}

function etaMinutes(timeStr) {
  if (!timeStr) return null;
  const nowP = perthNow();
  const parts = timeStr.split(':').map(Number);
  const eta = new Date(nowP);
  eta.setHours(parts[0], parts[1], parts[2] || 0, 0);
  if (eta < nowP) eta.setDate(eta.getDate() + 1);
  return Math.round((eta - nowP) / 60_000);
}

function formatEta(mins) {
  if (mins === null) return '\u2013';
  if (mins < 1) return 'Due';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

// ── Geography ──
function isInPerth(lat, lon) {
  return lat >= PERTH_BOUNDS.minLat && lat <= PERTH_BOUNDS.maxLat &&
         lon >= PERTH_BOUNDS.minLon && lon <= PERTH_BOUNDS.maxLon;
}

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function fmtDist(m) {
  if (m < 1000) return `${Math.round(m)}m`;
  return `${(m / 1000).toFixed(1)}km`;
}

// ── String helpers ──
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Strip "Stand X", "Bay Y", "Before ...", "After ..." suffixes from stop names
// so paired stops on opposite sides of a road share a common name.
function cleanStopName(name) {
  if (!name) return '';
  return name
    .replace(/\s+(Stand|Bay|Platform)\s+\S+$/i, '')
    .replace(/\s+(Before|After|Opposite|Near|At)\s+.*$/i, '')
    .replace(/\s*\(.*?\)\s*$/, '')
    .trim();
}

// ── Position parsing ──
// SJP returns positions as "lat lon" (space-separated) or "lat, lon" (comma)
function parsePosition(posStr) {
  if (!posStr) return null;
  const s = posStr.trim();
  let parts;
  if (s.includes(',')) {
    parts = s.split(',').map(x => parseFloat(x.trim()));
  } else {
    parts = s.split(/\s+/).map(parseFloat);
  }
  if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
    return { lat: parts[0], lon: parts[1] };
  }
  return null;
}

// ── Cardinal direction ──
function getCardinalDirection(fromLat, fromLon, toLat, toLon) {
  const dLat = toLat - fromLat;
  const dLon = toLon - fromLon;
  const angle = Math.atan2(dLon, dLat) * 180 / Math.PI; // 0=N, 90=E
  if (angle >= -22.5 && angle < 22.5) return 'N';
  if (angle >= 22.5 && angle < 67.5) return 'NE';
  if (angle >= 67.5 && angle < 112.5) return 'E';
  if (angle >= 112.5 && angle < 157.5) return 'SE';
  if (angle >= 157.5 || angle < -157.5) return 'S';
  if (angle >= -157.5 && angle < -112.5) return 'SW';
  if (angle >= -112.5 && angle < -67.5) return 'W';
  return 'NW';
}

// ── Google encoded polyline decoder ──
function decodeGooglePolyline(encoded) {
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let shift = 0, result = 0, byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

// ── Mode classification ──
function modeClass(mode) {
  if (!mode) return 'bus';
  const m = mode.toLowerCase();
  if (m.includes('rail') || m.includes('train')) return 'rail';
  if (m.includes('ferry')) return 'ferry';
  if (m.includes('school')) return 'school';
  return 'bus';
}

function modeColor(mode) {
  const mc = modeClass(mode);
  if (mc === 'rail') return 'var(--sand-gold)';
  if (mc === 'ferry') return 'var(--sky)';
  return 'var(--cactus)';
}
