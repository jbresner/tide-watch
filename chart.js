/**
 * TideWatch — chart.js  v1.2
 *
 * Changes from v1.1:
 *  - Fetch window: now−12h → now+12h (centered on current time)
 *  - Cross-midnight fetch: begin/end dates derived from window edges, not just "today"
 *  - Wider left margin to prevent y-axis label collision
 *  - Collision-aware hilo label placement (above/below with guard zones)
 *  - "Now" marker rendered last so it sits above chart elements
 *  - Canvas font sizes bumped to match CSS type scale
 *  - Improved color contrast for grid/axis text
 *  - loadTideData exposed on window for future scrolling phase
 */

'use strict';

// ─── NOAA API ─────────────────────────────────────────────────────────────────

const NOAA_DATA_URL = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';

const NOAA_BASE = {
  product:     'predictions',
  datum:       'MLLW',
  time_zone:   'lst_ldt',
  units:       'english',
  format:      'json',
  application: 'TideWatch',
};

// ─── Canvas color palette (mirrors CSS custom properties) ─────────────────────

const C = {
  navyMid:     '#111f30',
  navyLight:   '#1a2f45',
  tideBright:  '#2e9fd4',
  seafoam:     '#4ecdc4',
  textPrimary: '#e8f2f8',
  textSecond:  '#93bcd1',
  textMuted:   '#5a8aa0',
  gridLine:    'rgba(46, 159, 212, 0.14)',
  fillTop:     'rgba(46, 159, 212, 0.52)',
  fillBot:     'rgba(11, 22, 34, 0.0)',
  hiLabel:     '#4ecdc4',
  loLabel:     '#93bcd1',
  nowLine:     'rgba(232, 242, 248, 0.7)',
  nowDot:      '#e8f2f8',
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const chartSection      = document.getElementById('chart-section');
const chartStatusCard   = document.getElementById('chart-status-card');
const chartStatusIcon   = document.getElementById('chart-status-icon');
const chartStatusHLine  = document.getElementById('chart-status-headline');
const chartStatusDetail = document.getElementById('chart-status-detail');
const chartCard         = document.getElementById('chart-card');
const chartDateLabel    = document.getElementById('chart-date-label');
const chartRangeLabel   = document.getElementById('chart-range-label');
const chartStationMini  = document.getElementById('chart-station-mini');
const chartErrorCard    = document.getElementById('chart-error-card');
const chartErrorDetail  = document.getElementById('chart-error-detail');
const canvas            = document.getElementById('tide-canvas');
const ctx               = canvas.getContext('2d');

// ─── Module state ─────────────────────────────────────────────────────────────

let tidePoints  = [];   // {t: Date, v: number}[]   — interval=6 curve
let hiloPoints  = [];   // {t: Date, v: number, type:'H'|'L'}[]
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

function showChartError(msg) {
  hideChartStatus();
  chartCard.classList.add('hidden');
  chartErrorCard.classList.remove('hidden');
  chartErrorDetail.textContent = msg;
}

// ─── Date / format helpers ────────────────────────────────────────────────────

/** NOAA date format: YYYYMMDD */
function toNoaaDate(d) {
  const y  = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${y}${mo}${dy}`;
}

/**
 * NOAA returns "2026-05-24 14:30" in the station's local time (lst_ldt).
 * new Date("2026-05-24T14:30") is interpreted as LOCAL time in modern browsers,
 * which matches the station's adjusted time as long as the user's browser is
 * in the same timezone — acceptable for Phase 2. Full tz handling comes later.
 */
function parseNoaaTime(str) {
  return new Date(str.replace(' ', 'T'));
}

function fmtTime(d) {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
}

function fmtDateShort(d) {
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtDateFull(d) {
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

// ─── NOAA fetch (single call) ─────────────────────────────────────────────────

async function fetchNoaa(stationId, beginDate, endDate, interval) {
  const params = new URLSearchParams({
    ...NOAA_BASE,
    station:    stationId,
    begin_date: beginDate,
    end_date:   endDate,
    interval,
  });
  const url = `${NOAA_DATA_URL}?${params}`;
  console.log(`[TideWatch] fetch interval=${interval}`, url);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`NOAA HTTP ${res.status}`);

  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'NOAA API error');
  return data;
}

// ─── Load tide data (window = now−12h … now+12h) ─────────────────────────────
//
// The window can cross midnight, so begin_date and end_date may differ.
// We add an extra day of buffer on each side so the curve never runs dry
// near the window edges.

async function loadTideData(station) {
  const now = new Date();

  // Window edges
  const winStart = new Date(now.getTime() - 12 * 60 * 60 * 1000);
  const winEnd   = new Date(now.getTime() + 12 * 60 * 60 * 1000);

  // Fetch one day before winStart to one day after winEnd for safe margin
  const fetchStart = new Date(winStart);
  fetchStart.setDate(fetchStart.getDate() - 1);
  const fetchEnd = new Date(winEnd);
  fetchEnd.setDate(fetchEnd.getDate() + 1);

  const begin = toNoaaDate(fetchStart);
  const end   = toNoaaDate(fetchEnd);

  const [curveData, hiloData] = await Promise.all([
    fetchNoaa(station.id, begin, end, '6'),
    fetchNoaa(station.id, begin, end, 'hilo'),
  ]);

  tidePoints = (curveData.predictions || []).map(p => ({
    t: parseNoaaTime(p.t),
    v: parseFloat(p.v),
  }));

  hiloPoints = (hiloData.predictions || []).map(p => ({
    t: parseNoaaTime(p.t),
    v: parseFloat(p.v),
    type: p.type,
  }));

  console.log(`[TideWatch] ${tidePoints.length} curve pts, ${hiloPoints.length} hilo events`);
}

// expose for future scrolling module
window.tw = window.tw || {};
window.tw.loadTideData = loadTideData;
window.tw.getTidePoints = () => tidePoints;
window.tw.getHiloPoints = () => hiloPoints;

// ─── Canvas setup ─────────────────────────────────────────────────────────────

function setupCanvas() {
  const container = canvas.parentElement;
  const dpr  = window.devicePixelRatio || 1;
  const cssW = container.clientWidth;
  const cssH = Math.round(cssW * 0.54);  // aspect ratio — tall enough for labels

  canvas.style.width  = cssW + 'px';
  canvas.style.height = cssH + 'px';
  canvas.width  = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  return { w: cssW, h: cssH };
}

// ─── Chart renderer ───────────────────────────────────────────────────────────

function drawChart() {
  if (!tidePoints.length) return;

  const { w, h } = setupCanvas();

  // ── Margins — generous left for y-axis labels, top for hilo annotations ──
  const pad = { top: 36, right: 20, bottom: 46, left: 58 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top  - pad.bottom;

  // ── Centered 24-hour window ───────────────────────────────────────────────
  const now      = new Date();
  const winStart = new Date(now.getTime() - 12 * 60 * 60 * 1000);
  const winEnd   = new Date(now.getTime() + 12 * 60 * 60 * 1000);
  const winSpan  = winEnd - winStart;  // ms

  // Points within (and 1 point outside for curve continuity)
  const visible = tidePoints.filter(p => p.t >= winStart && p.t <= winEnd);

  // Extend by one point on each side so bezier starts/ends off-screen cleanly
  const idxFirst = tidePoints.findIndex(p => p.t >= winStart);
  const idxLast  = tidePoints.findIndex(p => p.t > winEnd);
  const extStart = idxFirst > 0 ? tidePoints[idxFirst - 1] : null;
  const extEnd   = idxLast  > 0 ? tidePoints[idxLast]      : null;
  const curve    = [extStart, ...visible, extEnd].filter(Boolean);

  if (visible.length < 2) {
    showChartError('Not enough tide data for the current window. Try reloading.');
    return;
  }

  // ── Y range across ALL loaded points (stable scale, not just window) ──────
  const allV  = tidePoints.map(p => p.v);
  const minV  = Math.min(...allV);
  const maxV  = Math.max(...allV);
  const vPad  = (maxV - minV) * 0.20;
  const yMin  = minV - vPad;
  const yMax  = maxV + vPad;

  // ── Coordinate mappers ────────────────────────────────────────────────────
  const xOf = t => pad.left + ((t - winStart) / winSpan) * plotW;
  const yOf = v => pad.top  + (1 - (v - yMin) / (yMax - yMin)) * plotH;

  // ── Clear & background ────────────────────────────────────────────────────
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = C.navyMid;
  ctx.fillRect(0, 0, w, h);

  // ── Horizontal grid + y-axis labels ──────────────────────────────────────
  ctx.save();
  ctx.strokeStyle  = C.gridLine;
  ctx.lineWidth    = 1;
  ctx.setLineDash([4, 7]);

  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i++) {
    const v = yMin + (i / gridSteps) * (yMax - yMin);
    const y = yOf(v);

    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();

    ctx.fillStyle    = C.textSecond;   // bumped from textMuted
    ctx.font         = '12px "DM Mono", monospace';
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(v.toFixed(1), pad.left - 8, y);
  }
  ctx.restore();

  // ── Vertical time ticks + x-axis labels ──────────────────────────────────
  // Ticks every hour, labels every 3 hours
  ctx.save();
  ctx.strokeStyle = C.gridLine;
  ctx.lineWidth   = 1;
  ctx.setLineDash([2, 9]);

  for (let offset = -12; offset <= 12; offset++) {
    const t = new Date(now.getTime() + offset * 60 * 60 * 1000);
    const x = xOf(t);

    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, pad.top + plotH);
    ctx.stroke();

    // Label every 3 hours, skip ±0 (that's the "now" line)
    if (offset % 3 === 0 && offset !== 0) {
      ctx.fillStyle    = C.textMuted;
      ctx.font         = '12px "DM Mono", monospace';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(fmtTime(t), x, pad.top + plotH + 7);
    }
  }
  ctx.restore();

  // ── Clipping region for curve + fill ─────────────────────────────────────
  // Prevents bezier overshoot from drawing outside plot area
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.left, pad.top, plotW, plotH);
  ctx.clip();

  // ── Filled area ──────────────────────────────────────────────────────────
  const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
  grad.addColorStop(0, C.fillTop);
  grad.addColorStop(1, C.fillBot);

  ctx.beginPath();
  ctx.moveTo(xOf(curve[0].t), yOf(curve[0].v));
  for (let i = 1; i < curve.length; i++) {
    const p = curve[i - 1], q = curve[i];
    const cpx = (xOf(p.t) + xOf(q.t)) / 2;
    ctx.bezierCurveTo(cpx, yOf(p.v), cpx, yOf(q.v), xOf(q.t), yOf(q.v));
  }
  ctx.lineTo(xOf(curve[curve.length - 1].t), pad.top + plotH);
  ctx.lineTo(xOf(curve[0].t), pad.top + plotH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // ── Tide line ─────────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.strokeStyle = C.tideBright;
  ctx.lineWidth   = 2.5;
  ctx.lineJoin    = 'round';
  ctx.lineCap     = 'round';
  ctx.setLineDash([]);

  ctx.moveTo(xOf(curve[0].t), yOf(curve[0].v));
  for (let i = 1; i < curve.length; i++) {
    const p = curve[i - 1], q = curve[i];
    const cpx = (xOf(p.t) + xOf(q.t)) / 2;
    ctx.bezierCurveTo(cpx, yOf(p.v), cpx, yOf(q.v), xOf(q.t), yOf(q.v));
  }
  ctx.stroke();

  ctx.restore(); // end clipping

  // ── Plot border ───────────────────────────────────────────────────────────
  ctx.save();
  ctx.strokeStyle = C.navyLight;
  ctx.lineWidth   = 1;
  ctx.setLineDash([]);
  ctx.strokeRect(pad.left, pad.top, plotW, plotH);
  ctx.restore();

  // ── High / Low tide labels ────────────────────────────────────────────────
  const visibleHilo = hiloPoints.filter(p => p.t >= winStart && p.t <= winEnd);

  // Track occupied vertical bands to detect collisions between labels
  // Each entry: { xMin, xMax, yMin, yMax }
  const occupied = [];

  function overlaps(r) {
    return occupied.some(o =>
      r.xMin < o.xMax && r.xMax > o.xMin &&
      r.yMin < o.yMax && r.yMax > o.yMin
    );
  }

  // Label dimensions (approximate, for collision math)
  const LBL_W  = 52;   // half-width of label block
  const LBL_H  = 32;   // total height of 2-line label block
  const DOT_R  = 4;
  const MARGIN = 6;    // gap between dot edge and label

  visibleHilo.forEach(p => {
    const px = xOf(p.t);
    const py = yOf(p.v);
    const isHigh   = p.type === 'H';
    const txtColor = isHigh ? C.hiLabel : C.loLabel;
    const heightTxt = `${p.v.toFixed(1)} ft`;
    const timeTxt   = fmtTime(p.t);

    // ── Dot ──────────────────────────────────────────────────────────────
    ctx.save();
    ctx.beginPath();
    ctx.arc(px, py, DOT_R, 0, Math.PI * 2);
    ctx.fillStyle   = txtColor;
    ctx.strokeStyle = C.navyMid;
    ctx.lineWidth   = 2;
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // ── Label placement ───────────────────────────────────────────────────
    // Preferred: highs above dot, lows below dot.
    // If that placement collides or escapes plot area, try the opposite.
    // X is clamped so the label stays within the plot's left/right bounds.

    const xClamped = Math.max(pad.left + LBL_W + 2, Math.min(px, pad.left + plotW - LBL_W - 2));

    function tryPlace(above) {
      const labelY = above
        ? py - DOT_R - MARGIN - LBL_H   // top of label block
        : py + DOT_R + MARGIN;           // top of label block

      const rect = {
        xMin: xClamped - LBL_W,
        xMax: xClamped + LBL_W,
        yMin: labelY,
        yMax: labelY + LBL_H,
      };

      // Must stay inside plot top margin
      if (rect.yMin < pad.top - 26) return null;  // allow into top margin
      if (rect.yMax > pad.top + plotH + 4) return null; // below plot bottom

      if (overlaps(rect)) return null;
      return { labelY, rect };
    }

    const preferAbove = isHigh;
    const placement =
      tryPlace(preferAbove) ||
      tryPlace(!preferAbove) ||
      // Force-place with preferred position if both collide (last resort)
      (() => {
        const labelY = preferAbove
          ? py - DOT_R - MARGIN - LBL_H
          : py + DOT_R + MARGIN;
        return { labelY, rect: null }; // null rect = don't register, allow overlap
      })();

    if (placement.rect) occupied.push(placement.rect);

    const labelY = placement.labelY;

    ctx.save();
    ctx.textAlign = 'center';

    // Height value (larger, colored)
    ctx.font      = '500 13px "DM Mono", monospace';
    ctx.fillStyle = txtColor;
    ctx.textBaseline = 'top';
    ctx.fillText(heightTxt, xClamped, labelY);

    // Time (smaller, secondary)
    ctx.font      = '12px "DM Mono", monospace';
    ctx.fillStyle = C.textSecond;
    ctx.fillText(timeTxt, xClamped, labelY + 16);

    ctx.restore();
  });

  // ── "Now" marker — rendered last so it sits above everything ─────────────
  const nowX = xOf(now);

  ctx.save();

  // Dashed vertical line
  ctx.strokeStyle = C.nowLine;
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(nowX, pad.top);
  ctx.lineTo(nowX, pad.top + plotH);
  ctx.stroke();

  // Small dot on the tide curve at now
  const nowV = interpolateAtTime(now);
  if (nowV !== null) {
    const nowY = yOf(nowV);
    ctx.beginPath();
    ctx.arc(nowX, nowY, 5, 0, Math.PI * 2);
    ctx.fillStyle   = C.nowDot;
    ctx.strokeStyle = C.navyMid;
    ctx.lineWidth   = 2;
    ctx.setLineDash([]);
    ctx.fill();
    ctx.stroke();
  }

  // "now" label in the top margin, above plot border
  ctx.setLineDash([]);
  ctx.font         = '500 12px "DM Mono", monospace';
  ctx.fillStyle    = C.textPrimary;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'bottom';

  // Keep label from running into the left axis
  const nowLabelX = Math.max(nowX, pad.left + 18);
  ctx.fillText('now', nowLabelX, pad.top - 6);

  ctx.restore();

  // ── Y-axis unit label ─────────────────────────────────────────────────────
  ctx.save();
  ctx.fillStyle    = C.textMuted;
  ctx.font         = '11px "DM Mono", monospace';
  ctx.textAlign    = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText('ft', pad.left - 8, pad.top - 2);
  ctx.restore();
}

// ─── Linear interpolation of tide height at an arbitrary time ────────────────

function interpolateAtTime(t) {
  if (!tidePoints.length) return null;
  const ts = t.getTime();

  for (let i = 1; i < tidePoints.length; i++) {
    const a = tidePoints[i - 1], b = tidePoints[i];
    if (ts >= a.t.getTime() && ts <= b.t.getTime()) {
      const frac = (ts - a.t.getTime()) / (b.t.getTime() - a.t.getTime());
      return a.v + frac * (b.v - a.v);
    }
  }
  return null;
}

// ─── Update chart header text ─────────────────────────────────────────────────

function updateHeader() {
  const now      = new Date();
  const winStart = new Date(now.getTime() - 12 * 60 * 60 * 1000);
  const winEnd   = new Date(now.getTime() + 12 * 60 * 60 * 1000);

  const startDay = winStart.toDateString();
  const endDay   = winEnd.toDateString();
  const nowDay   = now.toDateString();

  if (startDay === endDay) {
    // Window stays within one calendar day
    chartDateLabel.textContent = fmtDateFull(now);
    chartRangeLabel.textContent = '±12 hours';
  } else {
    // Window crosses midnight
    chartDateLabel.textContent =
      `${fmtDateShort(winStart)} – ${fmtDateShort(winEnd)}`;
    chartRangeLabel.textContent = '24 hr centered on now';
  }
}

// ─── Show chart ───────────────────────────────────────────────────────────────

function showChart(station) {
  updateHeader();
  chartStationMini.textContent = station.name;
  hideChartStatus();
  chartCard.classList.remove('hidden');
  drawChart();
}

// ─── React to station selection ───────────────────────────────────────────────

document.addEventListener('stationSelected', async (e) => {
  stationInfo = e.detail;

  chartSection.classList.remove('hidden');
  setChartStatus('loading', 'Loading tide data',
    `Fetching predictions for ${stationInfo.name}…`);

  try {
    await loadTideData(stationInfo);
    showChart(stationInfo);
  } catch (err) {
    console.error('[TideWatch] Tide data error:', err);
    showChartError(err.message);
  }
});

// ─── Redraw on resize ─────────────────────────────────────────────────────────

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!chartCard.classList.contains('hidden')) {
      updateHeader();
      drawChart();
    }
  }, 120);
});
