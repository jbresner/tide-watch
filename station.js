/**
 * TideWatch — station.js
 * Phase 1: Geolocation → NOAA station list → nearest harmonic station
 */

'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────

const NOAA_STATIONS_URL =
  'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions';

const CANDIDATE_COUNT = 10; // How many nearest stations to evaluate and display

// ─── DOM refs ────────────────────────────────────────────────────────────────

const statusIcon     = document.getElementById('status-icon');
const statusHeadline = document.getElementById('status-headline');
const statusDetail   = document.getElementById('status-detail');

const stationSection  = document.getElementById('station-section');
const stationTypeBadge= document.getElementById('station-type-badge');
const stationName     = document.getElementById('station-name');
const stationIdDisplay= document.getElementById('station-id-display');
const stationDistance = document.getElementById('station-distance');
const stationCoords   = document.getElementById('station-coords');
const candidatesList  = document.getElementById('candidates-list');

const userSection      = document.getElementById('user-section');
const userCoordsDisplay= document.getElementById('user-coords-display');

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

function kmToMiles(km) {
  return km * 0.621371;
}

// ─── Station type detection ───────────────────────────────────────────────────
// NOAA station objects have a `stationType` field. Known values:
//   'R' = reference / harmonic (preferred — supports interval=6)
//   'S' = subordinate (hilo only)
// Some older records omit the field; treat those as unknown and prefer
// them over known subordinates but below known reference stations.

function stationRank(station) {
  const t = (station.stationType || '').toUpperCase();
  if (t === 'R') return 0; // best
  if (t === '')  return 1; // unknown — might work
  return 2;                // subordinate
}

function stationTypeLabel(station) {
  const t = (station.stationType || '').toUpperCase();
  if (t === 'R') return 'harmonic';
  if (t === 'S') return 'subordinate';
  return 'unknown';
}

// ─── Fetch station list ───────────────────────────────────────────────────────

async function fetchStations() {
  // Check sessionStorage cache first
  const cached = sessionStorage.getItem('tw_stations');
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed && parsed.length > 0) {
        console.log(`[TideWatch] Using cached station list (${parsed.length} stations)`);
        return parsed;
      }
    } catch (_) { /* ignore corrupt cache */ }
  }

  setStatus('loading', 'Downloading tide stations', 'Fetching NOAA station metadata…');

  const res = await fetch(NOAA_STATIONS_URL);
  if (!res.ok) throw new Error(`NOAA metadata API returned ${res.status}`);

  const data = await res.json();
  const stations = (data.stations || []).filter(
    s => typeof s.lat === 'number' && typeof s.lng === 'number'
  );

  console.log(`[TideWatch] Loaded ${stations.length} tide prediction stations from NOAA`);

  sessionStorage.setItem('tw_stations', JSON.stringify(stations));
  return stations;
}

// ─── Find nearest stations ────────────────────────────────────────────────────

function findNearestStations(stations, userLat, userLon, count) {
  return stations
    .map(s => ({
      ...s,
      distKm: haversineKm(userLat, userLon, s.lat, s.lng),
    }))
    .sort((a, b) => {
      // Primary sort: distance
      // Secondary sort within 50 km: prefer reference stations
      const distDiff = a.distKm - b.distKm;
      if (Math.abs(distDiff) > 50) return distDiff;
      const rankDiff = stationRank(a) - stationRank(b);
      if (rankDiff !== 0) return rankDiff;
      return distDiff;
    })
    .slice(0, count);
}

// Picks the best station: closest harmonic within reasonable range,
// else falls back to closest overall.
function selectBestStation(candidates) {
  const harmonic = candidates.find(s => stationRank(s) === 0);
  if (harmonic) return harmonic;

  const unknown = candidates.find(s => stationRank(s) === 1);
  if (unknown) return unknown;

  return candidates[0]; // closest subordinate as last resort
}

// ─── Render station card ──────────────────────────────────────────────────────

function renderStation(station, allCandidates) {
  const typeLabel = stationTypeLabel(station);
  const distMi = kmToMiles(station.distKm).toFixed(1);
  const distKm = station.distKm.toFixed(1);

  stationTypeBadge.textContent = typeLabel;
  stationTypeBadge.className = typeLabel;
  stationName.textContent = station.name;
  stationIdDisplay.textContent = `ID ${station.id}`;
  stationDistance.textContent = `${distMi} mi · ${distKm} km`;
  stationCoords.textContent =
    `${station.lat.toFixed(4)}°, ${station.lng.toFixed(4)}°`;

  // Candidates list
  candidatesList.innerHTML = '';
  allCandidates.forEach((s, i) => {
    const isSelected = s.id === station.id;
    const row = document.createElement('div');
    row.className = 'candidate-row' + (isSelected ? ' selected-station' : '');

    const mi = kmToMiles(s.distKm).toFixed(1);
    const tl = stationTypeLabel(s);

    row.innerHTML = `
      <span class="candidate-name">${isSelected ? '▸ ' : ''}${s.name}</span>
      <span class="candidate-dist">${mi} mi</span>
      <span class="candidate-id">${s.id}</span>
      <span class="candidate-type ${tl}">${tl}</span>
    `;
    candidatesList.appendChild(row);
  });

  stationSection.classList.remove('hidden');
  console.log('[TideWatch] Selected station:', station);
}

// ─── Toggle candidates list ───────────────────────────────────────────────────

function toggleCandidates() {
  const list   = document.getElementById('candidates-list');
  const toggle = document.getElementById('candidates-toggle');
  const isOpen = !list.classList.contains('hidden');
  list.classList.toggle('hidden', isOpen);
  toggle.textContent = isOpen
    ? 'Show nearby candidates ▾'
    : 'Hide nearby candidates ▴';
}

// Expose to HTML onclick
window.toggleCandidates = toggleCandidates;

// ─── Main flow ────────────────────────────────────────────────────────────────

async function init() {
  setStatus('locating', 'Locating you', 'Requesting geolocation permission…');

  let userLat, userLon;

  try {
    const position = await new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        timeout: 12000,
        maximumAge: 60000,
        enableHighAccuracy: false,
      })
    );
    userLat = position.coords.latitude;
    userLon = position.coords.longitude;
  } catch (err) {
    setStatus('error', 'Location unavailable', err.message || 'Permission denied or timed out.');
    return;
  }

  // Show user coords
  userCoordsDisplay.textContent = `${userLat.toFixed(5)}°, ${userLon.toFixed(5)}°`;
  userSection.classList.remove('hidden');

  setStatus('loading', 'Finding nearest station', 'Downloading NOAA tide station list…');

  let stations;
  try {
    stations = await fetchStations();
  } catch (err) {
    setStatus('error', 'Station list failed', err.message);
    return;
  }

  setStatus('loading', 'Ranking stations', `Evaluating ${stations.length.toLocaleString()} tide stations…`);

  // Small async yield so the UI can paint the status update
  await new Promise(r => setTimeout(r, 30));

  const candidates = findNearestStations(stations, userLat, userLon, CANDIDATE_COUNT);
  const best = selectBestStation(candidates);

  setStatus('done', 'Station found', `Using ${best.name} · ${stationTypeLabel(best)}`);

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
