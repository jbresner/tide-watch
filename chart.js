/**
 * TideWatch — chart.js
 * Phase 2: Fetch NOAA tide predictions → render 24-hour Canvas chart
 *
 * Listens for the 'stationSelected' event from station.js, then:
 *  1. Fetches interval=6  predictions  (smooth curve data)
 *  2. Fetches interval=hilo predictions (high/low labels)
 *  3. Renders a Canvas tide chart
 */

'use strict';

// ─── NOAA API config ──────────────────────────────────────────────────────────

const NOAA_DATA_URL = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';

const NOAA_COMMON_PARAMS = {
  product:     'predictions',
  datum:       'MLLW',
  time_zone:   'lst_ldt',
  units:       'english',
  format:      'json',
  application: 'TideWatch',
};

// ─── Chart styling constants ──────────────────────────────────────────────────
// These match the CSS palette from style.css

const C = {
  navy:        '#0b1622',
  navyMid:     '#111f30',
  navyLight:   '#1a2f45',
  tide:        '#1e6fa8',
  tideBright:  '#2e9fd4',
  seafoam:     '#4ecdc4',
  sand:        '#c8b99a',
  textPrimary: '#dce8f0',
  textSecond:  '#7fa3b8',
  textMuted:   '#3d5a6e',
  gridLine:    'rgba(30, 111, 168, 0.18)',
  fill1:       'rgba(46, 159, 212, 0.55)',   // top of gradient fill
  fill2:       'rgba(11, 22, 34, 0.0)',      // bottom (transparent to navy)
  hiLabel:     '#4ecdc4',
  loLabel:     '#7fa3b8',
  nowLine:     'rgba(255, 255, 255, 0.55)',
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const chartSection      = document.getElementById('chart-section');
const chartStatusCard   = document.getElementById('chart-status-card');
const chartStatusIcon   = document.getElementById('chart-status-icon');
const chartStatusHLine  = document.getElementById('chart-status-headline');
const chartStatusDetail = document.getElementById('chart-status-detail');
const chartCard         = document.getElementById('chart-card');
const chartDateLabel    = document.getElementById('chart-date-label');
const chartStationMini  = document.getElementById('chart-station-mini');
const chartErrorCard    = document.getElementById('chart-error-card');
const chartErrorDetail  = document.getElementById('chart-error-detail');
const canvas            = document.getElementById('tide-canvas');
const ctx               = canvas.getContext('2d');

// ─── Chart state ──────────────────────────────────────────────────────────────

let tidePoints  = [];   // [{t: Date, v: number}, …]  interval=6
let hiloPoints  = [];   // [{t: Date, v: number, type: 'H'|'L'}, …]
let stationInfo = null;

// ─── Status helpers ───────────────────────────────────────────────────────────

function setChartStatus(state, headline, detail) {
  chartStatusCard.classList.remove('hidden');
  chartStatusIcon.className = `status-${state}`;
  chartStatusHLine.textContent = headline;
  chartStatusDetail.textContent = detail;
}

function hideChartStatus() {
  chartStatusCard.classList.add('hidden');
}

function showChartError(message) {
  hideChartStatus();
  chartCard.classList.add('hidden');
  chartErrorCard.classList.remove('hidden');
  chartErrorDetail.textContent = message;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function formatNoaaDate(d) {
  // NOAA wants YYYYMMDD
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function parseNoaaTime(str) {
  // NOAA returns "2026-05-24 14:30" in lst_ldt local time
  // We create a Date treating it as local — which matches since
  // the API already adjusted to the station's local time zone.
  return new Date(str.replace(' ', 'T'));
}

function formatTime(d) {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatDateHeader(d) {
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

// ─── NOAA fetch ───────────────────────────────────────────────────────────────

async function fetchNoaa(stationId, beginDate, endDate, interval) {
  const params = new URLSearchParams({
    ...NOAA_COMMON_PARAMS,
    station:    stationId,
    begin_date: beginDate,
    end_date:   endDate,
    interval,
  });

  const url = `${NOAA_DATA_URL}?${params}`;
  console.log(`[TideWatch] Fetching NOAA ${interval}:`, url);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from NOAA API`);

  const data = await res.json();

  if (data.error) {
    throw new Error(data.error.message || 'NOAA API error');
  }

  return data;
}

async function loadTideData(station) {
  const now   = new Date();
  const begin = formatNoaaDate(now);

  // Fetch 2 days to guarantee we have well past 24 hours regardless of time of day
  const end2 = new Date(now);
  end2.setDate(end2.getDate() + 2);
  const end = formatNoaaDate(end2);

  // Parallel fetch: smooth curve + hilo labels
  const [curveData, hiloData] = await Promise.all([
    fetchNoaa(station.id, begin, end, '6'),
    fetchNoaa(station.id, begin, end, 'hilo'),
  ]);

  // Parse smooth curve
  tidePoints = (curveData.predictions || []).map(p => ({
    t: parseNoaaTime(p.t),
    v: parseFloat(p.v),
  }));

  // Parse hilo
  hiloPoints = (hiloData.predictions || []).map(p => ({
    t: parseNoaaTime(p.t),
    v: parseFloat(p.v),
    type: p.type, // 'H' or 'L'
  }));

  console.log(`[TideWatch] Loaded ${tidePoints.length} curve points, ${hiloPoints.length} hilo events`);
}

// ─── Canvas chart renderer ────────────────────────────────────────────────────

function resizeCanvas() {
  const container = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const cssW = container.clientWidth;
  const cssH = Math.round(cssW * 0.52); // ~52% aspect ratio, feels nautical

  canvas.style.width  = cssW + 'px';
  canvas.style.height = cssH + 'px';
  canvas.width  = cssW * dpr;
  canvas.height = cssH * dpr;
  ctx.scale(dpr, dpr);

  return { w: cssW, h: cssH };
}

function drawChart() {
  if (!tidePoints.length) return;

  const { w, h } = resizeCanvas();

  // ── Layout margins ────────────────────────────────────────────────────────
  const pad = { top: 24, right: 18, bottom: 44, left: 48 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top  - pad.bottom;

  // ── Time window: now → now+24h ────────────────────────────────────────────
  const now       = new Date();
  const windowEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  // Filter points to window (keep 1 point before for path continuity)
  const visible = tidePoints.filter(p => p.t >= now && p.t <= windowEnd);

  if (visible.length < 2) {
    showChartError('Not enough tide data in the 24-hour window. Try reloading.');
    return;
  }

  // ── Y-axis: range with breathing room ────────────────────────────────────
  const allV = tidePoints.map(p => p.v);
  const minV = Math.min(...allV);
  const maxV = Math.max(...allV);
  const vPad = (maxV - minV) * 0.18;
  const yMin = minV - vPad;
  const yMax = maxV + vPad;

  // ── Coordinate mappers ────────────────────────────────────────────────────
  const xOf = t => pad.left + ((t - now) / (windowEnd - now)) * plotW;
  const yOf = v => pad.top  + (1 - (v - yMin) / (yMax - yMin)) * plotH;

  // ─ Clear ─────────────────────────────────────────────────────────────────
  ctx.clearRect(0, 0, w, h);

  // ─ Background ─────────────────────────────────────────────────────────────
  ctx.fillStyle = C.navyMid;
  ctx.fillRect(0, 0, w, h);

  // ─ Grid lines (horizontal, Y-axis values) ─────────────────────────────────
  ctx.save();
  ctx.strokeStyle = C.gridLine;
  ctx.lineWidth   = 1;
  ctx.setLineDash([4, 6]);

  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i++) {
    const v  = yMin + (i / gridSteps) * (yMax - yMin);
    const y  = yOf(v);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();

    // Y-axis labels
    ctx.fillStyle  = C.textMuted;
    ctx.font       = '11px "DM Mono", monospace';
    ctx.textAlign  = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(v.toFixed(1), pad.left - 6, y);
  }

  ctx.restore();

  // ─ Vertical "hour" tick marks on X-axis ──────────────────────────────────
  ctx.save();
  ctx.strokeStyle = C.gridLine;
  ctx.lineWidth   = 1;
  ctx.setLineDash([2, 8]);

  for (let h2 = 0; h2 <= 24; h2++) {
    const t = new Date(now.getTime() + h2 * 60 * 60 * 1000);
    const x = xOf(t);

    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, pad.top + plotH);
    ctx.stroke();

    // X-axis hour labels — every 3 hours, skip 0 and 24
    if (h2 % 3 === 0 && h2 > 0 && h2 < 24) {
      ctx.fillStyle    = C.textMuted;
      ctx.font         = '11px "DM Mono", monospace';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(formatTime(t), x, pad.top + plotH + 6);
    }
  }
  ctx.restore();

  // ─ Filled area under tide curve ───────────────────────────────────────────
  const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
  grad.addColorStop(0,   C.fill1);
  grad.addColorStop(1,   C.fill2);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(xOf(visible[0].t), yOf(visible[0].v));
  for (let i = 1; i < visible.length; i++) {
    const prev = visible[i - 1];
    const curr = visible[i];
    // Cubic bezier for smooth interpolation between 6-minute samples
    const cpx = (xOf(prev.t) + xOf(curr.t)) / 2;
    ctx.bezierCurveTo(cpx, yOf(prev.v), cpx, yOf(curr.v), xOf(curr.t), yOf(curr.v));
  }
  // Close path down to baseline
  const lastX = xOf(visible[visible.length - 1].t);
  const firstX = xOf(visible[0].t);
  const baseline = pad.top + plotH;
  ctx.lineTo(lastX, baseline);
  ctx.lineTo(firstX, baseline);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.restore();

  // ─ Tide line ──────────────────────────────────────────────────────────────
  ctx.save();
  ctx.beginPath();
  ctx.strokeStyle = C.tideBright;
  ctx.lineWidth   = 2;
  ctx.lineJoin    = 'round';
  ctx.lineCap     = 'round';

  ctx.moveTo(xOf(visible[0].t), yOf(visible[0].v));
  for (let i = 1; i < visible.length; i++) {
    const prev = visible[i - 1];
    const curr = visible[i];
    const cpx  = (xOf(prev.t) + xOf(curr.t)) / 2;
    ctx.bezierCurveTo(cpx, yOf(prev.v), cpx, yOf(curr.v), xOf(curr.t), yOf(curr.v));
  }
  ctx.stroke();
  ctx.restore();

  // ─ High/Low labels ────────────────────────────────────────────────────────
  const visibleHilo = hiloPoints.filter(p => p.t >= now && p.t <= windowEnd);

  visibleHilo.forEach(p => {
    const x = xOf(p.t);
    const y = yOf(p.v);
    const isHigh = p.type === 'H';
    const labelColor = isHigh ? C.hiLabel : C.loLabel;
    const dotR = 3.5;

    // Dot on the curve
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, dotR, 0, Math.PI * 2);
    ctx.fillStyle   = labelColor;
    ctx.strokeStyle = C.navyMid;
    ctx.lineWidth   = 1.5;
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Height label
    const heightText = `${p.v.toFixed(1)} ft`;
    const timeText   = formatTime(p.t);

    const labelOffsetY = isHigh ? -(dotR + 18) : (dotR + 8);

    ctx.save();
    ctx.font      = '500 11px "DM Mono", monospace';
    ctx.fillStyle = labelColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = isHigh ? 'bottom' : 'top';

    // Clamp label x so it doesn't bleed outside plot area
    const clampedX = Math.max(pad.left + 22, Math.min(x, pad.left + plotW - 22));

    ctx.fillText(heightText, clampedX, y + labelOffsetY);

    ctx.font      = '10px "DM Mono", monospace';
    ctx.fillStyle = C.textSecond;
    const timeOffsetY = isHigh ? labelOffsetY - 14 : labelOffsetY + 14;
    ctx.fillText(timeText, clampedX, y + timeOffsetY);
    ctx.restore();
  });

  // ─ "Now" vertical line ────────────────────────────────────────────────────
  ctx.save();
  const nowX = xOf(now);
  ctx.strokeStyle = C.nowLine;
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(nowX, pad.top);
  ctx.lineTo(nowX, pad.top + plotH);
  ctx.stroke();

  // "Now" label
  ctx.fillStyle    = C.textPrimary;
  ctx.font         = '10px "DM Mono", monospace';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText('now', nowX, pad.top - 4);
  ctx.restore();

  // ─ Y-axis unit label ──────────────────────────────────────────────────────
  ctx.save();
  ctx.fillStyle    = C.textMuted;
  ctx.font         = '10px "DM Mono", monospace';
  ctx.textAlign    = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('ft', 2, pad.top);
  ctx.restore();

  // ─ Plot border ────────────────────────────────────────────────────────────
  ctx.save();
  ctx.strokeStyle = C.navyLight;
  ctx.lineWidth   = 1;
  ctx.setLineDash([]);
  ctx.strokeRect(pad.left, pad.top, plotW, plotH);
  ctx.restore();
}

// ─── Show chart ───────────────────────────────────────────────────────────────

function showChart(station) {
  const now = new Date();
  chartDateLabel.textContent   = formatDateHeader(now);
  chartStationMini.textContent = station.name;
  hideChartStatus();
  chartCard.classList.remove('hidden');
  drawChart();
}

// ─── Main: react to station selection ────────────────────────────────────────

document.addEventListener('stationSelected', async (e) => {
  stationInfo = e.detail;

  chartSection.classList.remove('hidden');
  setChartStatus('loading', 'Loading tide data', `Fetching predictions for ${stationInfo.name}…`);

  try {
    await loadTideData(stationInfo);
    showChart(stationInfo);
  } catch (err) {
    console.error('[TideWatch] Tide data error:', err);
    showChartError(err.message);
  }
});

// ─── Redraw on resize ────────────────────────────────────────────────────────

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!chartCard.classList.contains('hidden')) drawChart();
  }, 120);
});
