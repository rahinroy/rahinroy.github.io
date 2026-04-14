export const config = { runtime: 'edge' };

// ── In-memory edge cache ──
// Persists across invocations within the same V8 isolate.
// Keyed on meaningful request fields (StopUid, TripUid) so repeated
// requests with different auth nonces still hit cache.
const cache = new Map();

const STOP_TTL = 25_000;        // 25s — landing polls every 30s
const TRIP_FULL_TTL = 20_000;   // 20s — full trip detail
const TRIP_UPDATE_TTL = 10_000; // 10s — position-only poll (frontend 8s)
const MAX_CACHE_SIZE = 300;

function getCacheKey(path, body) {
  try {
    const b = JSON.parse(body);
    if (path.includes('/Stop')) {
      return `stop:${b.StopUid}`;
    }
    if (path.includes('/Trip')) {
      return `trip:${b.TripUid}:${b.UpdateOnly ? 'u' : 'f'}`;
    }
  } catch {}
  return null;
}

function getTTL(path, body) {
  try {
    const b = JSON.parse(body);
    if (b.UpdateOnly) return TRIP_UPDATE_TTL;
  } catch {}
  if (path.includes('/Stop')) return STOP_TTL;
  if (path.includes('/Trip')) return TRIP_FULL_TTL;
  return 15_000;
}

function pruneCache() {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.ts > entry.ttl * 3) cache.delete(key);
  }
}

export default async function handler(request) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(request.url);
  const proxyPath = url.searchParams.get('p') || '/';
  const bodyText = await request.text();

  // ── Cache lookup ──
  const cacheKey = getCacheKey(proxyPath, bodyText);
  if (cacheKey) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.ts < hit.ttl) {
      return new Response(hit.body, {
        status: hit.status,
        headers: {
          'Content-Type': 'application/json',
          'X-Cache': 'HIT',
          ...corsHeaders,
        },
      });
    }
  }

  // ── Forward to Transperth ──
  const target = 'https://realtime.transperth.info' + proxyPath;
  const response = await fetch(target, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': request.headers.get('Authorization') || '',
      'User-Agent': 'okhttp/4.12.0',
    },
    body: bodyText,
  });

  const respBody = await response.text();

  // ── Cache store (200 only) ──
  if (cacheKey && response.status === 200) {
    cache.set(cacheKey, {
      body: respBody,
      status: 200,
      ts: Date.now(),
      ttl: getTTL(proxyPath, bodyText),
    });
    if (cache.size > MAX_CACHE_SIZE) pruneCache();
  }

  return new Response(respBody, {
    status: response.status,
    headers: {
      'Content-Type': response.headers.get('Content-Type') || 'application/json',
      'X-Cache': 'MISS',
      ...corsHeaders,
    },
  });
}
