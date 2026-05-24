/**
 * TideWatch — station.js  v1.5
 * Geolocation → NOAA station list → nearest harmonic station
 */

'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────

const NOAA_STATIONS_URL =
  'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions';

const CANDIDATE_COUNT = 10;

// ─── DOM refs ────────────────────────────────────────────────────────────────

const statusIcon     = document.getElementById('status-icon');
const statusHeadline = document.getElementById('status-headline');
const statusDetail   = document.getElementById('status-detail');

const stationSection   = document.getElementById('station-section');
const stationTypeBadge = document.getElementById('station-type-badge');
const stationName      = document.getElementById('station-name');
const stationIdDisplay = document.getElementById('station-id-display');
const candidatesList   = document.getElementById('candidates-list');

// ─── Status helpers ───────────────────────────────────────────────────────────

function setStatus(state, headline, detail) {
  statusIcon.className = `status-${state}`;
  statusHeadline.textContent = headline;
  statusDetail.textContent = detail;
}

// ─── Haversine distance (km) ──────────────────────────────────────────────────

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function kmToMiles(km) { return km * 0.621371; }

// ─── Station type ─────────────────────────────────────────────────────────────

function stationRank(station) {
  const t = (station.stationType || '').toUpperCase();
  if (t === 'R') return 0;
  if (t === '')  return 1;
  return 2;
}

function stationTypeLabel(station) {
  const t = (station.stationType || '').toUpperCase();
  if (t === 'R') return 'harmonic';
  if (t === 'S') return 'subordinate';
  return 'unknown';
}

// ─── Fetch station list ───────────────────────────────────────────────────────

async function fetchStations() {
  const cached = sessionStorage.getItem('tw_stations');
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed && parsed.length > 0) {
        console.log(`[TideWatch] Cached stations: ${parsed.length}`);
        return parsed;
      }
    } catch (_) {}
  }

  setStatus('loading', 'Downloading tide stations', 'Fetching NOAA station metadata…');

  const res = await fetch(NOAA_STATIONS_URL);
  if (!res.ok) throw new Error(`NOAA metadata API returned ${res.status}`);

  const data = await res.json();
  const stations = (data.stations || []).filter(
    s => typeof s.lat === 'number' && typeof s.lng === 'number'
  );

  console.log(`[TideWatch] Loaded ${stations.length} stations`);
  sessionStorage.setItem('tw_stations', JSON.stringify(stations));
  return stations;
}

// ─── Find nearest stations ────────────────────────────────────────────────────

function findNearestStations(stations, userLat, userLon, count) {
  return stations
    .map(s => ({ ...s, distKm: haversineKm(userLat, userLon, s.lat, s.lng) }))
    .sort((a, b) => {
      const distDiff = a.distKm - b.distKm;
      if (Math.abs(distDiff) > 50) return distDiff;
      const rankDiff = stationRank(a) - stationRank(b);
      return rankDiff !== 0 ? rankDiff : distDiff;
    })
    .slice(0, count);
}

function selectBestStation(candidates) {
  return candidates.find(s => stationRank(s) === 0)
      || candidates.find(s => stationRank(s) === 1)
      || candidates[0];
}

// ─── Render station card ──────────────────────────────────────────────────────

function renderStation(station, allCandidates) {
  const typeLabel = stationTypeLabel(station);

  if (typeLabel === 'unknown') {
    stationTypeBadge.textContent = '';
    stationTypeBadge.className = '';
    stationTypeBadge.style.display = 'none';
  } else {
    stationTypeBadge.textContent = typeLabel;
    stationTypeBadge.className = typeLabel;
    stationTypeBadge.style.display = '';
  }

  stationName.textContent = station.name;
  stationIdDisplay.textContent = `ID ${station.id}`;

  // Candidates list — name and ID only, no type label
  candidatesList.innerHTML = '';
  allCandidates.forEach(s => {
    const isSelected = s.id === station.id;
    const row = document.createElement('div');
    row.className = 'candidate-row' + (isSelected ? ' selected-station' : '');
    row.innerHTML = `
      <span class="candidate-name">${isSelected ? '▸ ' : ''}${s.name}</span>
      <span class="candidate-id">${s.id}</span>
    `;
    candidatesList.appendChild(row);
  });

  stationSection.classList.remove('hidden');
  console.log('[TideWatch] Selected station:', station);

  document.dispatchEvent(new CustomEvent('stationSelected', { detail: station }));
}

// ─── Toggle candidates list ───────────────────────────────────────────────────

function toggleCandidates() {
  const list   = document.getElementById('candidates-list');
  const toggle = document.getElementById('candidates-toggle');
  const isOpen = !list.classList.contains('hidden');
  list.classList.toggle('hidden', isOpen);
  toggle.textContent = isOpen ? 'View nearby stations ▾' : 'Hide nearby stations ▴';
}

window.toggleCandidates = toggleCandidates;

// ─── Main flow ────────────────────────────────────────────────────────────────

async function init() {
  setStatus('locating', 'Locating you', 'Requesting geolocation permission…');

  let userLat, userLon;
  try {
    const pos = await new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        timeout: 12000, maximumAge: 60000, enableHighAccuracy: false,
      })
    );
    userLat = pos.coords.latitude;
    userLon = pos.coords.longitude;
  } catch (err) {
    setStatus('error', 'Location unavailable', err.message || 'Permission denied or timed out.');
    return;
  }

  setStatus('loading', 'Finding nearest station', 'Downloading NOAA tide station list…');

  let stations;
  try {
    stations = await fetchStations();
  } catch (err) {
    setStatus('error', 'Station list failed', err.message);
    return;
  }

  setStatus('loading', 'Ranking stations', `Evaluating ${stations.length.toLocaleString()} stations…`);
  await new Promise(r => setTimeout(r, 30));

  const candidates = findNearestStations(stations, userLat, userLon, CANDIDATE_COUNT);
  const best = selectBestStation(candidates);

  document.getElementById('status-section').classList.add('hidden');
  renderStation(best, candidates);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

if (!navigator.geolocation) {
  setStatus('error', 'Geolocation not supported', 'Please use a modern browser with location support.');
} else {
  init().catch(err => {
    console.error('[TideWatch]', err);
    setStatus('error', 'Unexpected error', err.message);
  });
}
