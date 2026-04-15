'use strict';

// ── App State ──
const AppState = {
  view: 'landing',          // 'landing' | 'search'
  userLat: null,
  userLon: null,
  hasRealLocation: false,

  // Firebase
  realtimeKey: null,
  realtimeStopPath: '/SJP/Stop',

  // Landing view
  stations: [],              // grouped paired stops
  arrivals: {},              // stationId -> { data:{}, loadedAt }
  activeStationId: null,

  // Search view
  searchTrip: null,          // { tripUid, tripDate, routeCode, summary, tripStops } (selected trip)
  searchTrips: [],           // all tracked trips on route (for 8s polling)
  searchAllTrips: [],        // all matching trips from arrivals
  searchDirections: {},      // headsign -> [trips]
  searchActiveDirection: null, // currently selected headsign (null = first)
  searchRouteCode: null,

  // Timers
  landingRefreshTimer: null,
  landingEtaTimer: null,
  searchPollTimer: null,

  // Map state
  lastLoadCenter: null,
  panTimer: null,
};

// ── DOM references ──
const DOM = {};

function cacheDom() {
  DOM.sidebar = document.getElementById('sidebar');
  DOM.sidebarHeader = document.getElementById('sidebar-header');
  DOM.sidebarHeaderText = document.getElementById('sidebar-header-text');
  DOM.backBtn = document.getElementById('back-btn');
  DOM.sidebarContent = document.getElementById('sidebar-content');
  DOM.refreshIndicator = document.getElementById('refresh-indicator');
  DOM.refreshProgress = document.getElementById('refresh-progress');
  DOM.refreshLabel = document.getElementById('refresh-label');
  DOM.errorBanner = document.getElementById('error-banner');
  DOM.distLabel = document.getElementById('dist-label');
  DOM.routeInput = document.getElementById('route-input');
  DOM.routeSearchBtn = document.getElementById('route-search-btn');
  DOM.routeDropdown = document.getElementById('route-dropdown');
  DOM.routeSearch = document.getElementById('route-search');
}

// ── Helpers ──
function showError(msg) {
  DOM.errorBanner.textContent = msg;
  DOM.errorBanner.classList.add('visible');
}

function clearError() {
  DOM.errorBanner.classList.remove('visible');
}

function setDistLabel(text) {
  DOM.distLabel.textContent = text;
}

// ── Station grouping ──
// Group nearby stops into "stations" by proximity + cleaned name match.
function groupStopsIntoStations(stops) {
  const stations = [];
  const used = new Set();

  for (let i = 0; i < stops.length; i++) {
    if (used.has(i)) continue;
    const anchor = stops[i];
    const anchorClean = cleanStopName(anchor.name);
    const members = [anchor];
    used.add(i);

    for (let j = i + 1; j < stops.length; j++) {
      if (used.has(j)) continue;
      const candidate = stops[j];
      const dist = haversineM(anchor.lat, anchor.lon, candidate.lat, candidate.lon);
      if (dist > STATION_GROUP_M) continue;
      const candClean = cleanStopName(candidate.name);
      // Check if they share a common prefix (at least 5 chars)
      const minLen = Math.min(anchorClean.length, candClean.length, 5);
      if (anchorClean.slice(0, minLen) === candClean.slice(0, minLen)) {
        members.push(candidate);
        used.add(j);
      }
    }

    // Station center = average of members
    const sLat = members.reduce((s, m) => s + m.lat, 0) / members.length;
    const sLon = members.reduce((s, m) => s + m.lon, 0) / members.length;
    const sDist = members.reduce((s, m) => s + m.dist, 0) / members.length;
    const stationId = members.map(m => m.uid).sort().join('|');
    const stationName = anchorClean || anchor.name;

    stations.push({
      id: stationId,
      name: stationName,
      lat: sLat,
      lon: sLon,
      dist: sDist,
      stops: members,
    });
  }

  stations.sort((a, b) => a.dist - b.dist);
  return stations.slice(0, MAX_STATIONS);
}

// ── Extract live bus positions from arrivals ──
function extractBusPositions() {
  const buses = [];
  const seen = new Set();

  Object.values(AppState.arrivals).forEach(({ data }) => {
    if (!data?.Trips) return;
    data.Trips.forEach(trip => {
      const sm = trip.Summary || {};
      const smRt = sm.RealTimeInfo;
      if (!smRt?.CurrentPosition) return;
      const pos = parsePosition(smRt.CurrentPosition);
      if (!pos) return;
      // Skip if no ETA data at all
      const { mins } = getTripEta(trip);
      if (mins === null) return;
      const key = sm.TripUid || smRt.CurrentPosition;
      if (seen.has(key)) return;
      seen.add(key);
      const tripDate = trip.DepartureTime || trip.ArriveTime || sm.TripStartTime || perthNowStr();
      buses.push({
        tripUid: key,
        lat: pos.lat,
        lon: pos.lon,
        routeCode: sm.RouteCode || '',
        routeName: sm.RouteName || '',
        mode: sm.Mode || 'Bus',
        headsign: sm.Headsign || '',
        tripDate,
      });
    });
  });

  return buses;
}

// ── Compute ETA info for a trip ──
function getTripEta(trip) {
  const rt = trip.RealTimeInfo || {};
  const smRt = (trip.Summary || {}).RealTimeInfo || null;
  const isLive = !!smRt;
  const estTime = rt.EstimatedArrivalTime || (smRt && smRt.EstimatedArrivalTime);

  let mins = null;
  if (estTime) {
    mins = etaMinutes(estTime);
  } else if (trip.ArriveTime) {
    mins = Math.round((new Date(trip.ArriveTime) - perthNow()) / 60_000);
  } else if (trip.DepartureTime) {
    mins = Math.round((new Date(trip.DepartureTime) - perthNow()) / 60_000);
  }

  let etaClass = '';
  if (mins !== null) {
    if (mins < 1) etaClass = 'due';
    else if (mins <= 5) etaClass = 'soon';
  }

  let etaDisplay = mins !== null ? formatEta(mins) : '\u2013';
  // Non-live: prefix with ~ to indicate estimated/scheduled
  if (!isLive && mins !== null) {
    etaDisplay = '~' + etaDisplay;
  }

  return { mins, isLive, etaClass, etaDisplay, estTime };
}

// ── Deduplicate trips: one per route+direction, soonest arrival ──
function dedupeByRouteDirection(trips) {
  const best = {};
  trips.forEach(trip => {
    const sm = trip.Summary || {};
    const route = sm.RouteCode || sm.RouteName || '?';
    const headsign = sm.Headsign || '';
    const key = `${route}::${headsign}`;
    const { mins } = getTripEta(trip);
    if (mins !== null && mins < -1) return;
    if (!best[key] || (mins !== null && (best[key].mins === null || mins < best[key].mins))) {
      best[key] = { trip, mins };
    }
  });
  // Sort by soonest ETA
  return Object.values(best)
    .sort((a, b) => (a.mins ?? 999) - (b.mins ?? 999))
    .map(e => e.trip);
}

// ── Render arrival row (landing view: 1 per route+direction) ──
function renderArrivalRow(trip) {
  const sm = trip.Summary || {};
  const mode = sm.Mode || 'Bus';
  const route = sm.RouteCode ||
    (sm.RouteName ? sm.RouteName.replace(/\s*Line\s*$/i, '').slice(0, 3).toUpperCase() : '?');
  const headsign = sm.Headsign || '';

  const { mins, isLive, etaClass, etaDisplay, estTime } = getTripEta(trip);
  if (mins !== null && mins < -1) return '';

  const schedTime = trip.ArriveTime ? trip.ArriveTime.slice(11, 16) : null;
  const schedMins = schedTime ? Math.round((new Date(trip.ArriveTime) - perthNow()) / 60_000) : null;
  const showSched = estTime && schedMins !== null && Math.abs(mins - schedMins) > 2;

  const tripUid = sm.TripUid || '';
  const tripDate = trip.DepartureTime || trip.ArriveTime || perthNowStr();
  const overlay = MapManager.getRouteOverlay();
  const isSelected = overlay && overlay.tripUid === tripUid;

  return `
    <div class="arrival-row${isSelected ? ' selected' : ''}" data-trip-uid="${escHtml(tripUid)}" data-trip-date="${escHtml(tripDate)}" data-route-code="${escHtml(sm.RouteCode || '')}">
      <div class="route-badge ${modeClass(mode)}">${escHtml(route)}</div>
      <div class="arrival-dest">${escHtml(headsign)}</div>
      ${showSched ? `<div class="arrival-sched">${schedTime}</div>` : ''}
      <div class="arrival-eta ${etaClass}">${etaDisplay}</div>
      <div class="live-dot ${isLive ? '' : 'grey'}"></div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════
// LANDING VIEW
// ═══════════════════════════════════════════════════

function renderLanding() {
  const content = DOM.sidebarContent;
  DOM.backBtn.style.display = 'none';
  DOM.sidebarHeaderText.textContent = 'Nearby Stops';
  DOM.routeSearch.style.display = '';
  DOM.refreshIndicator.style.display = '';

  if (AppState.stations.length === 0) {
    content.innerHTML = '<div class="state-msg"><span class="icon">&#x1F68F;</span>No stops found nearby.</div>';
    return;
  }

  // Auto-expand bottom sheet on mobile
  if (DOM.sidebar.classList.contains('collapsed') && Object.keys(AppState.arrivals).length > 0) {
    DOM.sidebar.classList.remove('collapsed');
    setTimeout(() => MapManager.invalidateSize(), 350);
  }

  let html = '';
  AppState.stations.forEach(station => {
    const isActive = station.id === AppState.activeStationId;

    // Merge arrivals from all member stops, dedup by TripUid
    const seenTrips = new Set();
    const allTrips = [];
    station.stops.forEach(stop => {
      const arr = AppState.arrivals[station.id];
      if (!arr?.data) return;
      (arr.data.Trips || []).forEach(trip => {
        const uid = (trip.Summary || {}).TripUid;
        if (uid && seenTrips.has(uid)) return;
        if (uid) seenTrips.add(uid);
        allTrips.push(trip);
      });
    });

    // Deduplicate: one row per route+direction, showing soonest arrival
    const dedupedTrips = dedupeByRouteDirection(allTrips);
    const rows = dedupedTrips.map(trip => renderArrivalRow(trip)).filter(r => r !== '');
    const hasArr = AppState.arrivals[station.id] !== undefined;

    const arrivalHTML = !hasArr
      ? `<div class="state-msg compact"><span class="spinner small"></span>Loading\u2026</div>`
      : rows.length === 0
        ? `<div class="state-msg compact">No services in the next 2 hours</div>`
        : `<div class="arrivals-list">${rows.slice(0, 5).join('')}</div>`;

    // Stop numbers
    const stopNums = station.stops
      .filter(s => s.publicNumber)
      .map(s => `<span class="stop-number">${s.publicNumber}</span>`)
      .join(' ');

    html += `
      <div class="stop-card${isActive ? ' active' : ''}" data-station-id="${escHtml(station.id)}">
        <div class="stop-header">
          <span class="stop-name">${escHtml(station.name)}</span>
          <div class="stop-meta">
            ${stopNums}
            <span class="stop-dist">${fmtDist(station.dist)}</span>
          </div>
        </div>
        ${arrivalHTML}
      </div>
    `;
  });

  content.innerHTML = html;

  // Wire click handlers
  content.querySelectorAll('.stop-card[data-station-id]').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.dataset.stationId;
      selectStation(id);
    });
  });

  content.querySelectorAll('.arrival-row[data-trip-uid]').forEach(row => {
    row.addEventListener('click', e => {
      e.stopPropagation();
      const uid = row.dataset.tripUid;
      const date = row.dataset.tripDate;
      const routeCode = row.dataset.routeCode;
      if (uid) transitionToSearch(uid, date, routeCode);
    });
  });
}

function selectStation(stationId) {
  AppState.activeStationId = stationId;
  const station = AppState.stations.find(s => s.id === stationId);
  if (station) {
    MapManager.panTo(station.lat, station.lon);
    MapManager.updateStationMarkers(AppState.stations, stationId);
  }
  renderLanding();
}

// ── Arrival fetching ──
async function fetchStationArrivals(station) {
  if (!AppState.realtimeKey) return;
  // Fetch arrivals from all member stops, merge
  const allTrips = [];
  const seenUids = new Set();

  for (const stop of station.stops) {
    try {
      const data = await getArrivals(stop.uid, AppState.realtimeKey, AppState.realtimeStopPath);
      (data.Trips || []).forEach(trip => {
        const uid = (trip.Summary || {}).TripUid;
        if (uid && seenUids.has(uid)) return;
        if (uid) seenUids.add(uid);
        allTrips.push(trip);
      });
      clearError();
    } catch (err) {
      console.error(`[arrivals] stop ${stop.uid}:`, err);
      if (err instanceof TypeError && err.message.toLowerCase().includes('fetch')) {
        showError('CORS error: arrivals unavailable. Stop data still shown.');
      } else {
        showError(`Arrivals error (${stop.uid}): ${err.message}`);
      }
    }
  }

  AppState.arrivals[station.id] = {
    data: { Trips: allTrips },
    loadedAt: Date.now(),
  };
}

async function refreshAllArrivals() {
  if (!AppState.realtimeKey || AppState.view !== 'landing') return;

  for (const station of AppState.stations) {
    if (AppState.view !== 'landing') return;
    await fetchStationArrivals(station);
  }

  if (AppState.view !== 'landing') return;
  renderLanding();
  updateBusMarkersFromArrivals();
  startLandingCountdown();
}

function startLandingCountdown() {
  DOM.refreshProgress.style.animation = 'none';
  DOM.refreshProgress.offsetHeight; // reflow
  DOM.refreshProgress.style.animation = `countdown ${LANDING_REFRESH_MS / 1000}s linear forwards`;
  DOM.refreshLabel.textContent = `Refreshing in ${LANDING_REFRESH_MS / 1000}s`;
}

function startLandingTimers() {
  stopLandingTimers();
  AppState.landingRefreshTimer = setInterval(refreshAllArrivals, LANDING_REFRESH_MS);
  AppState.landingEtaTimer = setInterval(() => {
    if (AppState.view === 'landing') renderLanding();
  }, ETA_REFRESH_MS);
}

function stopLandingTimers() {
  if (AppState.landingRefreshTimer) { clearInterval(AppState.landingRefreshTimer); AppState.landingRefreshTimer = null; }
  if (AppState.landingEtaTimer) { clearInterval(AppState.landingEtaTimer); AppState.landingEtaTimer = null; }
}

function updateBusMarkersFromArrivals() {
  const buses = extractBusPositions();
  const overlay = MapManager.getRouteOverlay();
  const selectedUid = AppState.searchTrip?.tripUid || null;
  MapManager.updateBusMarkers(buses, overlay?.routeCode || null, selectedUid);
}

// ═══════════════════════════════════════════════════
// SEARCH VIEW
// ═══════════════════════════════════════════════════

async function transitionToSearch(tripUid, tripDate, routeCode) {
  AppState.view = 'search';
  stopLandingTimers();

  DOM.backBtn.style.display = 'inline-block';
  DOM.sidebarHeaderText.textContent = routeCode ? `Route ${routeCode}` : 'Trip Details';
  DOM.routeSearch.style.display = 'none';
  DOM.refreshIndicator.style.display = 'none';
  DOM.sidebarContent.innerHTML = '<div class="state-msg"><div class="spinner"></div>Loading route\u2026</div>';

  AppState.searchRouteCode = routeCode;
  AppState.searchActiveDirection = null;

  // Step 1: Fetch all buses on this route via a known stop
  let allMatchingTrips = [];
  const stopId = ROUTE_STOPS[routeCode];

  if (stopId && AppState.realtimeKey) {
    try {
      const data = await getArrivals(stopId, AppState.realtimeKey, AppState.realtimeStopPath);
      allMatchingTrips = (data.Trips || []).filter(t => (t.Summary || {}).RouteCode === routeCode);
    } catch (err) {
      console.error('[search] route arrivals failed:', err);
    }
  }

  // Also merge in any trips we already had from landing arrivals
  const seenUids = new Set(allMatchingTrips.map(t => (t.Summary || {}).TripUid).filter(Boolean));
  Object.values(AppState.arrivals).forEach(({ data }) => {
    if (!data?.Trips) return;
    data.Trips.forEach(trip => {
      const sm = trip.Summary || {};
      if (sm.RouteCode !== routeCode || !sm.TripUid) return;
      if (seenUids.has(sm.TripUid)) return;
      seenUids.add(sm.TripUid);
      allMatchingTrips.push(trip);
    });
  });

  AppState.searchAllTrips = allMatchingTrips;

  // Group by direction (headsign)
  const directions = {};
  allMatchingTrips.forEach(trip => {
    const hs = (trip.Summary || {}).Headsign || 'Unknown';
    if (!directions[hs]) directions[hs] = [];
    directions[hs].push(trip);
  });
  AppState.searchDirections = directions;

  // Pick the direction that contains the clicked trip, or first direction
  const headsigns = Object.keys(directions);
  if (tripUid) {
    for (const hs of headsigns) {
      if (directions[hs].some(t => (t.Summary || {}).TripUid === tripUid)) {
        AppState.searchActiveDirection = hs;
        break;
      }
    }
  }
  if (!AppState.searchActiveDirection && headsigns.length > 0) {
    AppState.searchActiveDirection = headsigns[0];
  }

  // Store arrivals for bus markers
  AppState.arrivals['_route_search'] = {
    data: { Trips: allMatchingTrips },
    loadedAt: Date.now(),
  };
  updateBusMarkersFromArrivals();

  // Step 2: Determine which trip to select
  // If a specific trip was clicked, use that. Otherwise pick the soonest in the active direction.
  let selectedTripUid = tripUid;
  let selectedTripDate = tripDate;
  if (!selectedTripUid && AppState.searchActiveDirection) {
    const dirTrips = directions[AppState.searchActiveDirection] || [];
    let bestMins = Infinity;
    dirTrips.forEach(trip => {
      const sm = trip.Summary || {};
      const { mins } = getTripEta(trip);
      if (mins !== null && mins >= -1 && mins < bestMins) {
        bestMins = mins;
        selectedTripUid = sm.TripUid;
        selectedTripDate = trip.DepartureTime || trip.ArriveTime || perthNowStr();
      }
    });
  }

  // Step 3: Load the selected trip's route detail (polyline + stops)
  if (selectedTripUid) {
    try {
      const tripData = await getTrip(selectedTripUid, selectedTripDate, AppState.realtimeKey);
      const summary = tripData.Summary || {};
      AppState.searchTrip = {
        tripUid: selectedTripUid,
        tripDate: selectedTripDate,
        routeCode: routeCode || summary.RouteCode || '',
        summary,
        tripStops: tripData.TripStops || [],
      };
      MapManager.drawRoute(tripData, routeCode);
      updateBusMarkersFromArrivals();
    } catch (err) {
      console.error('[trip]', err);
    }
  }

  // Render the search sidebar with all buses
  renderSearchView();

  // Set up polling for all trips on this route
  collectRouteTrips(routeCode);
  startSearchPoll();

  EventBus.emit('view-changed', 'search');
}

function transitionToLanding() {
  AppState.view = 'landing';
  stopSearchPoll();

  MapManager.clearRoute();
  AppState.searchTrip = null;
  AppState.searchTrips = [];
  AppState.searchAllTrips = [];
  AppState.searchDirections = {};
  AppState.searchActiveDirection = null;
  AppState.searchRouteCode = null;

  // Remove synthetic route search arrivals
  delete AppState.arrivals['_route_search'];

  DOM.routeInput.value = '';
  renderLanding();
  updateBusMarkersFromArrivals();
  MapManager.updateStationMarkers(AppState.stations, AppState.activeStationId);

  if (AppState.realtimeKey && AppState.stations.length > 0) {
    startLandingTimers();
    refreshAllArrivals();
  }

  EventBus.emit('view-changed', 'landing');
}

function renderSearchView() {
  const routeCode = AppState.searchRouteCode || '?';
  const directions = AppState.searchDirections;
  const headsigns = Object.keys(directions);
  const activeDir = AppState.searchActiveDirection;
  const activeTrips = directions[activeDir] || [];
  const selectedTripUid = AppState.searchTrip?.tripUid;

  if (headsigns.length === 0) {
    DOM.sidebarContent.innerHTML = `<div class="state-msg"><span class="icon">&#x1F50D;</span>No active buses on route ${escHtml(routeCode)} right now.</div>`;
    return;
  }

  // Direction toggle tabs
  let dirTabsHtml = '';
  if (headsigns.length > 1) {
    dirTabsHtml = '<div class="direction-tabs">';
    headsigns.forEach(hs => {
      const count = directions[hs].length;
      const isActive = hs === activeDir;
      dirTabsHtml += `<button class="direction-tab${isActive ? ' active' : ''}" data-direction="${escHtml(hs)}">
        <span class="direction-arrow">\u2192</span> ${escHtml(hs)}
        <span class="direction-tab-count">${count}</span>
      </button>`;
    });
    dirTabsHtml += '</div>';
  }

  // Bus cards for active direction (skip trips with no ETA)
  let busCardsHtml = '';
  activeTrips.forEach(trip => {
    const sm = trip.Summary || {};
    const smRt = sm.RealTimeInfo || null;
    const mode = sm.Mode || 'Bus';
    const tripUid = sm.TripUid || '';
    const tripDate = trip.DepartureTime || trip.ArriveTime || perthNowStr();
    const isLive = !!smRt;
    const isSelected = tripUid === selectedTripUid;

    const { mins, etaClass, etaDisplay, estTime } = getTripEta(trip);
    if (mins === null || mins < -2) return;

    // Fleet number if available
    const fleetNum = smRt?.VehicleNumber || '';

    // Scheduled time
    const schedTime = trip.ArriveTime ? trip.ArriveTime.slice(11, 16) : null;
    const schedMins = schedTime ? Math.round((new Date(trip.ArriveTime) - perthNow()) / 60_000) : null;
    const showSched = estTime && schedMins !== null && Math.abs(mins - schedMins) > 2;

    busCardsHtml += `
      <div class="bus-card${isSelected ? ' selected' : ''}" data-trip-uid="${escHtml(tripUid)}" data-trip-date="${escHtml(tripDate)}">
        <div class="bus-card-header">
          <div class="route-badge ${modeClass(mode)}">${escHtml(routeCode)}</div>
          <div class="bus-card-info">
            <span class="bus-card-eta ${etaClass}">${etaDisplay}</span>
            ${showSched ? `<span class="arrival-sched">${schedTime}</span>` : ''}
          </div>
          <div class="bus-card-status">
            <div class="live-dot ${isLive ? '' : 'grey'}"></div>
            ${fleetNum ? `<span class="bus-card-fleet">#${escHtml(fleetNum)}</span>` : ''}
          </div>
        </div>
      </div>
    `;
  });

  // Trip stop timeline (for selected trip)
  let timelineHtml = '';
  if (AppState.searchTrip) {
    const tripStops = AppState.searchTrip.tripStops;
    const summary = AppState.searchTrip.summary || {};
    const mode = summary.Mode || 'Bus';
    const headsign = summary.Headsign || activeDir || '';

    // Cardinal direction
    let dirBadge = '';
    if (tripStops.length >= 2) {
      const first = parsePosition(tripStops[0].TransitStop?.Position);
      const last = parsePosition(tripStops[tripStops.length - 1].TransitStop?.Position);
      if (first && last) {
        const cardinal = getCardinalDirection(first.lat, first.lon, last.lat, last.lon);
        dirBadge = `<span class="direction-badge">${cardinal}</span>`;
      }
    }

    let stopsHtml = '';
    let passedCount = 0;
    let firstUpcomingIdx = -1;
    tripStops.forEach((ts, i) => {
      const rtInfo = ts.RealTimeInfo || {};
      const isPassed = rtInfo.RealTimeTripStatus === 3;
      if (isPassed) passedCount++;
      if (!isPassed && firstUpcomingIdx === -1) firstUpcomingIdx = i;
      const stopName = ts.TransitStop?.Description || '';
      const etaStr = ts.DepartureTime
        ? ts.DepartureTime.slice(11, 16)
        : (ts.ArrivalTime ? ts.ArrivalTime.slice(11, 16) : '');

      stopsHtml += `
        <div class="search-stop ${isPassed ? 'passed' : 'upcoming'}" data-stop-idx="${i}">
          <div class="search-stop-dot ${isPassed ? 'passed' : ''}"></div>
          <div class="search-stop-info">
            <span class="search-stop-name">${escHtml(stopName)}</span>
            ${etaStr ? `<span class="search-stop-eta">${etaStr}</span>` : ''}
          </div>
        </div>
      `;
    });

    timelineHtml = `
      <div class="search-trip-label">
        <span class="direction-arrow">\u2192</span> ${escHtml(headsign)} ${dirBadge}
        <span class="search-meta">${tripStops.length} stops</span>
      </div>
      <div class="search-timeline" id="search-timeline">
        ${stopsHtml}
      </div>
    `;

    // We'll scroll to the first upcoming stop after DOM insertion
    AppState._scrollToStopIdx = firstUpcomingIdx;
  }

  DOM.sidebarContent.innerHTML = `
    ${dirTabsHtml}
    <div class="search-bus-list">
      ${busCardsHtml || '<div class="state-msg compact">No buses in this direction</div>'}
    </div>
    ${timelineHtml}
  `;

  // Wire direction tab clicks
  DOM.sidebarContent.querySelectorAll('.direction-tab').forEach(tab => {
    tab.addEventListener('click', async () => {
      AppState.searchActiveDirection = tab.dataset.direction;
      AppState.searchTrip = null;
      MapManager.clearRoute();

      // Auto-select soonest bus in new direction
      const dirTrips = AppState.searchDirections[tab.dataset.direction] || [];
      let bestMins = Infinity, bestUid = null, bestDate = null;
      dirTrips.forEach(trip => {
        const sm = trip.Summary || {};
        const { mins } = getTripEta(trip);
        if (mins !== null && mins >= -1 && mins < bestMins) {
          bestMins = mins;
          bestUid = sm.TripUid;
          bestDate = trip.DepartureTime || trip.ArriveTime || perthNowStr();
        }
      });

      if (bestUid) {
        try {
          const tripData = await getTrip(bestUid, bestDate, AppState.realtimeKey);
          const summary = tripData.Summary || {};
          AppState.searchTrip = {
            tripUid: bestUid,
            tripDate: bestDate,
            routeCode: AppState.searchRouteCode || summary.RouteCode || '',
            summary,
            tripStops: tripData.TripStops || [],
          };
          MapManager.drawRoute(tripData, AppState.searchRouteCode);
        } catch (err) {
          console.error('[trip]', err);
        }
      }

      renderSearchView();
    });
  });

  // Wire bus card clicks -> load that trip's route on map
  DOM.sidebarContent.querySelectorAll('.bus-card[data-trip-uid]').forEach(card => {
    card.addEventListener('click', async () => {
      const uid = card.dataset.tripUid;
      const date = card.dataset.tripDate;
      if (!uid) return;

      // Load this trip's detail
      try {
        const tripData = await getTrip(uid, date, AppState.realtimeKey);
        const summary = tripData.Summary || {};
        AppState.searchTrip = {
          tripUid: uid,
          tripDate: date,
          routeCode: AppState.searchRouteCode || summary.RouteCode || '',
          summary,
          tripStops: tripData.TripStops || [],
        };
        MapManager.drawRoute(tripData, AppState.searchRouteCode);
        updateBusMarkersFromArrivals();
        renderSearchView();
      } catch (err) {
        console.error('[trip]', err);
        showError(`Could not load trip: ${err.message}`);
      }
    });
  });

  // Wire stop clicks -> highlight on map
  DOM.sidebarContent.querySelectorAll('.search-stop[data-stop-idx]').forEach(row => {
    row.addEventListener('click', () => {
      const idx = parseInt(row.dataset.stopIdx, 10);
      // Highlight in sidebar
      DOM.sidebarContent.querySelectorAll('.search-stop').forEach(r => r.classList.remove('highlighted'));
      row.classList.add('highlighted');
      // Highlight on map
      MapManager.highlightRouteStop(idx);
    });
  });

  // Scroll timeline to first upcoming stop
  if (AppState._scrollToStopIdx >= 0) {
    const timeline = document.getElementById('search-timeline');
    const targetStop = timeline?.querySelector(`.search-stop[data-stop-idx="${AppState._scrollToStopIdx}"]`);
    if (timeline && targetStop) {
      requestAnimationFrame(() => {
        // Scroll only the timeline container, not the whole sidebar
        timeline.scrollTop = targetStop.offsetTop - timeline.offsetTop;
      });
    }
    AppState._scrollToStopIdx = -1;
  }
}

function collectRouteTrips(routeCode) {
  const seen = new Set();
  AppState.searchTrips = [];

  Object.values(AppState.arrivals).forEach(({ data }) => {
    if (!data?.Trips) return;
    data.Trips.forEach(trip => {
      const sm = trip.Summary || {};
      if (sm.RouteCode !== routeCode || !sm.TripUid) return;
      if (seen.has(sm.TripUid)) return;
      seen.add(sm.TripUid);
      const tripDate = sm.TripStartTime || trip.DepartureTime || trip.ArriveTime || '';
      AppState.searchTrips.push({ tripUid: sm.TripUid, tripDate });
    });
  });

  console.log(`[search] tracking ${AppState.searchTrips.length} trips on route ${routeCode}`);
}

function startSearchPoll() {
  stopSearchPoll();
  AppState.searchPollTimer = setInterval(pollSearchTrips, SEARCH_POLL_MS);
}

function stopSearchPoll() {
  if (AppState.searchPollTimer) { clearInterval(AppState.searchPollTimer); AppState.searchPollTimer = null; }
}

async function pollSearchTrips() {
  if (AppState.view !== 'search' || !AppState.realtimeKey) return;

  for (const t of AppState.searchTrips) {
    if (AppState.view !== 'search') return;
    try {
      const data = await getTripUpdate(t.tripUid, t.tripDate, AppState.realtimeKey);
      if (!data || AppState.view !== 'search') continue;
      const rt = data.Summary?.RealTimeInfo;
      if (rt?.CurrentPosition) {
        const pos = parsePosition(rt.CurrentPosition);
        if (pos) {
          MapManager.updateBusPosition(t.tripUid, pos.lat, pos.lon);
        }
      }
    } catch (err) {
      console.error('[search-poll]', t.tripUid, err);
    }
  }
}

// ═══════════════════════════════════════════════════
// ROUTE SEARCH (from header input)
// ═══════════════════════════════════════════════════

async function searchRoute(routeCode) {
  const stopId = ROUTE_STOPS[routeCode];
  if (!stopId) {
    showError(`Route "${routeCode}" not found`);
    return;
  }
  if (!AppState.realtimeKey) {
    showError('Realtime key not loaded yet');
    return;
  }

  // Use transitionToSearch with no specific trip -- it will fetch all buses on the route
  await transitionToSearch(null, null, routeCode);
}

// ═══════════════════════════════════════════════════
// ROUTE SEARCH AUTOCOMPLETE
// ═══════════════════════════════════════════════════

function initRouteSearchUI() {
  const input = DOM.routeInput;
  const btn = DOM.routeSearchBtn;
  const dropdown = DOM.routeDropdown;
  let highlightIdx = -1;

  function doSearch(val) {
    val = (val || input.value).trim().toUpperCase();
    if (!val) return;
    input.value = val;
    hideDropdown();
    btn.disabled = true;
    searchRoute(val).finally(() => { btn.disabled = false; });
  }

  function hideDropdown() {
    dropdown.classList.remove('visible');
    dropdown.innerHTML = '';
    highlightIdx = -1;
  }

  function showDropdown(matches) {
    if (matches.length === 0) { hideDropdown(); return; }
    highlightIdx = -1;
    dropdown.innerHTML = matches.map(m =>
      `<div class="route-option" data-route="${m}">Route ${m}</div>`
    ).join('');
    dropdown.classList.add('visible');

    dropdown.querySelectorAll('.route-option').forEach(opt => {
      opt.addEventListener('mousedown', e => {
        e.preventDefault();
        doSearch(opt.dataset.route);
      });
    });
  }

  function updateHighlight() {
    const opts = dropdown.querySelectorAll('.route-option');
    opts.forEach((o, i) => o.classList.toggle('highlighted', i === highlightIdx));
    if (highlightIdx >= 0 && opts[highlightIdx]) {
      opts[highlightIdx].scrollIntoView({ block: 'nearest' });
    }
  }

  input.addEventListener('input', () => {
    const val = input.value.trim().toUpperCase();
    if (!val) {
      hideDropdown();
      if (AppState.view === 'search') {
        transitionToLanding();
      }
      return;
    }
    const matches = ROUTE_NAMES.filter(r => r.startsWith(val)).slice(0, 15);
    showDropdown(matches);
  });

  input.addEventListener('keydown', e => {
    const opts = dropdown.querySelectorAll('.route-option');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (opts.length) { highlightIdx = Math.min(highlightIdx + 1, opts.length - 1); updateHighlight(); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (opts.length) { highlightIdx = Math.max(highlightIdx - 1, 0); updateHighlight(); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightIdx >= 0 && opts[highlightIdx]) {
        doSearch(opts[highlightIdx].dataset.route);
      } else {
        doSearch();
      }
    } else if (e.key === 'Escape') {
      hideDropdown();
    }
  });

  input.addEventListener('blur', () => { setTimeout(hideDropdown, 150); });
  btn.addEventListener('click', () => doSearch());
}

// ═══════════════════════════════════════════════════
// MAP PAN TO REFRESH
// ═══════════════════════════════════════════════════

async function loadStopsAtCenter() {
  if (AppState.view !== 'landing') return;

  const map = MapManager.getMap();
  const center = map.getCenter();
  const lat = center.lat;
  const lon = center.lng;

  // Skip if haven't moved far enough
  if (AppState.lastLoadCenter) {
    const moved = haversineM(AppState.lastLoadCenter.lat, AppState.lastLoadCenter.lon, lat, lon);
    if (moved < MAP_MOVE_THRESHOLD_M) return;
  }

  AppState.lastLoadCenter = { lat, lon };
  setDistLabel('Loading stops\u2026');

  try {
    const stops = await findNearbyStops(lat, lon);
    stops.sort((a, b) => a.dist - b.dist);
    const stations = groupStopsIntoStations(stops);
    AppState.stations = stations;

    if (stations.length > 0) {
      const nearest = stations[0];
      setDistLabel(`${fmtDist(nearest.dist)} from center`);
      AppState.activeStationId = nearest.id;
    } else {
      setDistLabel('No stops nearby');
    }

    renderLanding();
    MapManager.updateStationMarkers(stations, AppState.activeStationId);

    if (AppState.realtimeKey && stations.length > 0) {
      AppState.arrivals = {};
      await refreshAllArrivals();
    }
  } catch (err) {
    console.error('[pan-refresh]', err);
  }
}

function initMapPanHandler() {
  const map = MapManager.getMap();
  map.on('moveend', () => {
    clearTimeout(AppState.panTimer);
    AppState.panTimer = setTimeout(loadStopsAtCenter, MAP_SETTLE_MS);
  });
}

// ═══════════════════════════════════════════════════
// MOBILE BOTTOM SHEET
// ═══════════════════════════════════════════════════

function initMobileSheet() {
  const isMobile = () => window.matchMedia('(max-width: 700px)').matches;

  DOM.sidebarHeader.addEventListener('click', e => {
    if (!isMobile()) return;
    e.stopPropagation();
    DOM.sidebar.classList.toggle('collapsed');
    setTimeout(() => MapManager.invalidateSize(), 350);
  });

  if (isMobile()) {
    DOM.sidebar.classList.add('collapsed');
  }

  window.addEventListener('resize', () => {
    if (!isMobile()) {
      DOM.sidebar.classList.remove('collapsed');
    }
  });
}

// ═══════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════

async function init() {
  cacheDom();
  const map = MapManager.init('map');

  // Back button
  DOM.backBtn.addEventListener('click', () => {
    if (AppState.view === 'search') {
      transitionToLanding();
    }
  });

  // Title click -> back to landing
  document.getElementById('app-title').addEventListener('click', () => {
    if (AppState.view === 'search') {
      transitionToLanding();
    }
  });

  initRouteSearchUI();
  initMobileSheet();
  initMapPanHandler();

  // EventBus listeners
  EventBus.on('station-clicked', id => {
    if (AppState.view === 'landing') selectStation(id);
  });

  EventBus.on('bus-clicked', ({ tripUid, tripDate }) => {
    const buses = extractBusPositions();
    const bus = buses.find(b => b.tripUid === tripUid);
    transitionToSearch(tripUid, tripDate, bus?.routeCode || '');
  });

  DOM.sidebarContent.innerHTML = '<div class="state-msg"><div class="spinner"></div>Getting your location\u2026</div>';

  // 1. Get user location
  let lat, lon;
  let hasRealLocation = false;
  try {
    ({ lat, lon } = await new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('Geolocation not supported'));
      navigator.geolocation.getCurrentPosition(
        pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
        err => reject(err),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
      );
    }));
    hasRealLocation = true;
  } catch {
    lat = PERTH_CENTER.lat;
    lon = PERTH_CENTER.lon;
    setDistLabel('Perth CBD (location unavailable)');
  }

  if (!isInPerth(lat, lon)) {
    lat = PERTH_CENTER.lat;
    lon = PERTH_CENTER.lon;
    hasRealLocation = false;
    setDistLabel('Perth CBD');
  }

  AppState.userLat = hasRealLocation ? lat : null;
  AppState.userLon = hasRealLocation ? lon : null;
  AppState.hasRealLocation = hasRealLocation;
  MapManager.setView(lat, lon, 15);
  if (hasRealLocation) {
    MapManager.setUserPosition(lat, lon);
    setDistLabel('Loading stops\u2026');
  }

  DOM.sidebarContent.innerHTML = '<div class="state-msg"><div class="spinner"></div>Finding nearby stops\u2026</div>';

  // 2. Bootstrap Firebase Remote Config
  try {
    const rc = await loadRemoteConfig();
    AppState.realtimeKey = rc.api_key_realtime;
    if (rc.stop_path) AppState.realtimeStopPath = rc.stop_path;
    console.log('[boot] realtime key:', AppState.realtimeKey);
  } catch (err) {
    console.error('[boot] RC failed:', err);
    showError(`Firebase Remote Config failed: ${err.message}. Arrivals unavailable.`);
    AppState.realtimeKey = null;
  }

  // 3. Find nearby stops + group into stations
  try {
    const stops = await findNearbyStops(lat, lon);
    stops.sort((a, b) => a.dist - b.dist);
    const stations = groupStopsIntoStations(stops);
    AppState.stations = stations;

    if (stations.length === 0) throw new Error('No stops returned');

    const nearest = stations[0];
    setDistLabel(`${fmtDist(nearest.dist)} from you`);
    AppState.activeStationId = nearest.id;

    renderLanding();
    MapManager.updateStationMarkers(stations, nearest.id);

    // Fit map to user + stations
    const bounds = L.latLngBounds([[lat, lon]]);
    stations.forEach(s => bounds.extend([s.lat, s.lon]));
    MapManager.fitBounds(bounds, 0.15);
    AppState.lastLoadCenter = { lat, lon };

  } catch (err) {
    console.error('[stops]', err);
    DOM.sidebarContent.innerHTML = `<div class="state-msg"><span class="icon">&#x1F68C;</span>Could not find nearby stops.<br><small>${escHtml(err.message)}</small></div>`;
    setDistLabel('No stops found');
    return;
  }

  // 4. Fetch arrivals
  if (AppState.realtimeKey) {
    await refreshAllArrivals();
    startLandingTimers();
  } else {
    DOM.sidebarContent.innerHTML = '<div class="state-msg"><span class="icon">&#x26A0;</span>Could not fetch arrival data. Stop locations shown on map.</div>';
    renderLanding();
  }
}

document.addEventListener('DOMContentLoaded', init);
