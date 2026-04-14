'use strict';

// ── Map module ──
// Manages Leaflet map, tiles, markers, polylines, and icons.

const MapManager = (() => {
  let _map = null;
  let _userMarker = null;
  const _stopMarkers = {};   // stationId -> marker
  const _busMarkers = {};    // tripUid -> marker
  let _routeOverlay = null;  // { polylines:[], stopMarkers:[], tripUid, routeCode }

  // ── Init ──
  function init(elementId) {
    _map = L.map(elementId, { zoomControl: true, attributionControl: true })
      .setView([PERTH_CENTER.lat, PERTH_CENTER.lon], 14);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      crossOrigin: true,
    }).addTo(_map);

    return _map;
  }

  function getMap() { return _map; }

  // ── Icons ──
  function userIcon() {
    return L.divIcon({
      className: '',
      html: `<div style="
        width:16px; height:16px; border-radius:50%;
        background:#4a8c5c; border:3px solid white;
        box-shadow:0 0 8px rgba(74,140,92,0.8);
      "></div>`,
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
  }

  function stationIcon(active) {
    const bg = active ? '#4a8c5c' : '#c4b9a8';
    const border = active ? 'white' : '#e0d8cc';
    const shadow = active ? '0 0 6px rgba(74,140,92,0.7)' : 'none';
    return L.divIcon({
      className: '',
      html: `<div style="
        width:12px; height:12px; border-radius:50%;
        background:${bg}; border:2px solid ${border};
        box-shadow:${shadow};
      "></div>`,
      iconSize: [12, 12],
      iconAnchor: [6, 6],
    });
  }

  function busIcon(routeCode, routeName, mode) {
    const mc = modeClass(mode);
    let color;
    if (mc === 'rail') color = '#d4a843';
    else if (mc === 'ferry') color = '#5ba4d4';
    else color = '#4a8c5c';
    const label = routeCode ||
      (routeName ? routeName.replace(/\s*Line\s*$/i, '').slice(0, 3).toUpperCase() : '?');
    return L.divIcon({
      className: 'bus-label',
      html: `<div style="
        background:${color}; color:white; font-size:10px; font-weight:800;
        padding:2px 5px; border-radius:5px; white-space:nowrap;
      ">${escHtml(label)}</div>`,
      iconSize: null,
      iconAnchor: [14, 10],
    });
  }

  // ── User marker ──
  function setUserPosition(lat, lon) {
    if (!_map) return;
    if (!_userMarker) {
      _userMarker = L.marker([lat, lon], { icon: userIcon(), zIndexOffset: 1000 })
        .bindTooltip('You are here', { className: 'stop-marker-label', direction: 'top', permanent: false })
        .addTo(_map);
    } else {
      _userMarker.setLatLng([lat, lon]);
    }
  }

  // ── Station markers ──
  function updateStationMarkers(stations, activeStationId) {
    const currentIds = new Set(Object.keys(_stopMarkers));
    const routeActive = !!_routeOverlay;

    stations.forEach(station => {
      const isActive = station.id === activeStationId;
      if (_stopMarkers[station.id]) {
        _stopMarkers[station.id].setIcon(stationIcon(isActive));
        _stopMarkers[station.id].setOpacity(routeActive ? 0 : 1);
      } else {
        const marker = L.marker([station.lat, station.lon], { icon: stationIcon(isActive) })
          .bindTooltip(station.name, { className: 'stop-marker-label', direction: 'top', permanent: false })
          .addTo(_map);
        marker.on('click', () => EventBus.emit('station-clicked', station.id));
        if (routeActive) marker.setOpacity(0);
        _stopMarkers[station.id] = marker;
      }
      currentIds.delete(station.id);
    });

    // Remove stale
    currentIds.forEach(id => {
      if (_stopMarkers[id]) {
        _map.removeLayer(_stopMarkers[id]);
        delete _stopMarkers[id];
      }
    });
  }

  // ── Bus markers ──
  function updateBusMarkers(trips, activeRouteCode) {
    const liveUids = new Set();

    trips.forEach(({ tripUid, lat, lon, routeCode, routeName, mode, headsign, tripDate }) => {
      liveUids.add(tripUid);
      if (_busMarkers[tripUid]) {
        _busMarkers[tripUid].setLatLng([lat, lon]);
        _busMarkers[tripUid]._tripDate = tripDate;
        _busMarkers[tripUid]._routeCode = routeCode || '';
      } else {
        const icon = busIcon(routeCode, routeName, mode);
        const marker = L.marker([lat, lon], { icon, zIndexOffset: 500 })
          .bindTooltip(`Route ${routeCode} \u2192 ${headsign || ''}`, { direction: 'top' })
          .addTo(_map);
        marker._tripUid = tripUid;
        marker._tripDate = tripDate;
        marker._routeCode = routeCode || '';
        marker.on('click', () => {
          EventBus.emit('bus-clicked', { tripUid: marker._tripUid, tripDate: marker._tripDate });
        });
        _busMarkers[tripUid] = marker;
      }
    });

    // Visibility based on active route
    Object.entries(_busMarkers).forEach(([key, marker]) => {
      if (activeRouteCode && marker._routeCode !== activeRouteCode) {
        marker.setOpacity(0);
        if (marker.getTooltip()) marker.closeTooltip();
      } else {
        marker.setOpacity(1);
      }
    });

    // Remove stale
    Object.keys(_busMarkers).forEach(key => {
      if (!liveUids.has(key)) {
        _map.removeLayer(_busMarkers[key]);
        delete _busMarkers[key];
      }
    });
  }

  // Update a single bus marker position (for 8s poll)
  function updateBusPosition(tripUid, lat, lon) {
    if (_busMarkers[tripUid]) {
      _busMarkers[tripUid].setLatLng([lat, lon]);
    }
  }

  function getBusMarkers() { return _busMarkers; }

  // ── Route overlay ──
  function drawRoute(tripData, routeCode) {
    clearRoute();

    const summary = tripData.Summary || {};
    const polylineStr = summary.Polyline || '';
    const tripStops = tripData.TripStops || [];
    const mode = summary.Mode || 'Bus';
    const mc = modeClass(mode);
    let routeColor;
    if (mc === 'rail') routeColor = '#d4a843';
    else if (mc === 'ferry') routeColor = '#5ba4d4';
    else routeColor = '#4a8c5c';

    // Parse polyline
    let coords = [];
    if (polylineStr) {
      if (/^[A-Za-z0-9_~@?\\{}|`^[\]]+$/.test(polylineStr) && !polylineStr.includes(',')) {
        coords = decodeGooglePolyline(polylineStr);
      } else if (polylineStr.includes(';')) {
        polylineStr.split(';').forEach(pair => {
          const parts = pair.split(',').map(s => parseFloat(s.trim()));
          if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
            coords.push([parts[0], parts[1]]);
          }
        });
      }
    }

    // Fallback: build line from stop positions
    if (coords.length === 0) {
      tripStops.forEach(ts => {
        const pos = parsePosition(ts.TransitStop?.Position);
        if (pos) coords.push([pos.lat, pos.lon]);
      });
    }

    // Determine which stops have been passed
    const passedStopIndices = new Set();
    let lastPassedCoordIdx = -1;
    tripStops.forEach((ts, i) => {
      const rtInfo = ts.RealTimeInfo || {};
      if (rtInfo.RealTimeTripStatus === 3) {
        passedStopIndices.add(i);
        // Find approximate position in coords array
        const pos = parsePosition(ts.TransitStop?.Position);
        if (pos && coords.length > 0) {
          let bestIdx = 0, bestDist = Infinity;
          coords.forEach((c, ci) => {
            const d = haversineM(pos.lat, pos.lon, c[0], c[1]);
            if (d < bestDist) { bestDist = d; bestIdx = ci; }
          });
          if (bestIdx > lastPassedCoordIdx) lastPassedCoordIdx = bestIdx;
        }
      }
    });

    const polylines = [];

    if (coords.length >= 2) {
      if (lastPassedCoordIdx > 0 && lastPassedCoordIdx < coords.length - 1) {
        // Split into visited (grey dashed) and unvisited (solid colored) segments
        const visitedCoords = coords.slice(0, lastPassedCoordIdx + 1);
        const unvisitedCoords = coords.slice(lastPassedCoordIdx);

        const visitedLine = L.polyline(visitedCoords, {
          color: '#9e9585',
          weight: 4,
          opacity: 0.5,
          dashArray: '8,6',
        }).addTo(_map);
        polylines.push(visitedLine);

        const unvisitedLine = L.polyline(unvisitedCoords, {
          color: routeColor,
          weight: 4,
          opacity: 0.75,
        }).addTo(_map);
        polylines.push(unvisitedLine);
      } else {
        // No visited segment info: draw full line
        const line = L.polyline(coords, {
          color: routeColor,
          weight: 4,
          opacity: 0.75,
        }).addTo(_map);
        polylines.push(line);
      }
    }

    // Stop dots
    const stopMarkers = [];
    tripStops.forEach((ts, i) => {
      const pos = parsePosition(ts.TransitStop?.Position);
      if (!pos) return;
      const isPassed = passedStopIndices.has(i);
      const stopName = ts.TransitStop?.Description || '';
      const etaStr = ts.DepartureTime
        ? ts.DepartureTime.slice(11, 16)
        : (ts.ArrivalTime ? ts.ArrivalTime.slice(11, 16) : '');
      const tooltipText = etaStr ? `${stopName} \u2014 ${etaStr}` : stopName;

      const marker = L.circleMarker([pos.lat, pos.lon], {
        radius: 5,
        color: isPassed ? '#9e9585' : routeColor,
        fillColor: isPassed ? '#c4b9a8' : '#fff',
        fillOpacity: 1,
        weight: 2,
      })
        .bindTooltip(tooltipText, { direction: 'top', className: 'stop-marker-label' })
        .addTo(_map);
      stopMarkers.push(marker);
    });

    _routeOverlay = {
      polylines,
      stopMarkers,
      tripUid: summary.TripUid || routeCode,
      routeCode: routeCode || summary.RouteCode || '',
    };

    // Hide station markers
    Object.values(_stopMarkers).forEach(m => m.setOpacity(0));

    // Fit bounds
    if (polylines.length > 0) {
      const bounds = L.latLngBounds([]);
      polylines.forEach(p => bounds.extend(p.getBounds()));
      _map.fitBounds(bounds.pad(0.1));
    } else if (stopMarkers.length > 0) {
      const bounds = L.latLngBounds(stopMarkers.map(m => m.getLatLng()));
      _map.fitBounds(bounds.pad(0.1));
    }

    return { tripStops, summary };
  }

  function clearRoute() {
    if (!_routeOverlay) return;
    _routeOverlay.polylines.forEach(p => _map.removeLayer(p));
    _routeOverlay.stopMarkers.forEach(m => _map.removeLayer(m));
    _routeOverlay = null;
    // Restore station markers
    Object.values(_stopMarkers).forEach(m => m.setOpacity(1));
  }

  function getRouteOverlay() { return _routeOverlay; }

  function setView(lat, lon, zoom) { _map.setView([lat, lon], zoom); }
  function panTo(lat, lon) { _map.panTo([lat, lon], { animate: true }); }
  function fitBounds(bounds, pad) { _map.fitBounds(bounds.pad(pad || 0.15)); }
  function invalidateSize() { _map.invalidateSize(); }

  return {
    init,
    getMap,
    setUserPosition,
    updateStationMarkers,
    updateBusMarkers,
    updateBusPosition,
    getBusMarkers,
    drawRoute,
    clearRoute,
    getRouteOverlay,
    setView,
    panTo,
    fitBounds,
    invalidateSize,
  };
})();
