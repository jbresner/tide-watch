/**
 * TideWatch — chart.js  v1.3
 *
 * Changes from v1.2:
 *  - Removed chartRangeLabel and chartStationMini references (elements removed)
 *  - X-axis: wall-clock-aligned labels (12 AM, 3 AM, 6 AM … 9 PM) not offset-from-now
 *  - Y-axis: clean rounded tick values computed from data range (whole ft or 0.5 ft steps)
 *  - "ft" unit label moved to left of axis above the topmost tick, with clear separation
 *  - updateHeader simplified — only sets chartDateLabel
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

// ─── Canvas palette (mirrors CSS vars) ───────────────────────────────────────

const C = {
  navyMid:     '#111f30',
  navyLight:   '#1a2f45',
  tideBright:  '#2e9fd4',
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
const chartErrorCard    = document.getElementById('chart-error-card');
const chartErrorDetail  = document.getElementById('chart-error-detail');
const canvas            = document.getElementById('tide-canvas');
const ctx               = canvas.getContext('2d');

// ─── Module state ─────────────────────────────────────────────────────────────

let tidePoints  = [];   // {t: Date, v: number}[]
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

function toNoaaDate(d) {
  const y  = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${y}${mo}${dy}`;
}

function parseNoaaTime(str) {
  return new Date(str.replace(' ', 'T'));
}

/** "3 PM", "12 AM" etc. — no minutes, cleaner axis labels */
function fmtHourLabel(d) {
  const h = d.getHours();
  if (h === 0)  return '12 AM';
  if (h === 12) return '12 PM';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

/** "2:34 PM" — for hilo point labels where minutes matter */
function fmtTimeExact(d) {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
}

function fmtDateShort(d) {
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtDateFull(d) {
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

// ─── Y-axis tick computation ──────────────────────────────────────────────────
//
// Given the data min/max, compute clean human-readable tick values.
// Strategy:
//   1. Try whole-foot steps (step = 1) — use if we get 4–7 ticks
//   2. Try half-foot steps (step = 0.5) — use if range is small
//   3. Fall back to 2 ft steps for very large tidal ranges
//
// Returns {ticks: number[], yMin: number, yMax: number} where yMin/yMax
// are the padded axis extents (tick-aligned, slightly beyond data range).

function computeYTicks(dataMin, dataMax) {
  const range = dataMax - dataMin;

  // Choose a step size that gives 4–7 ticks across the data range
  let step;
  if      (range <= 3)  step = 0.5;
  else if (range <= 8)  step = 1;
  else if (range <= 16) step = 2;
  else                  step = 5;

  // Snap axis extents outward to the nearest step boundary,
  // with a small margin so data doesn't touch the edge
  const margin = step * 0.5;
  const axisMin = Math.floor((dataMin - margin) / step) * step;
  const axisMax = Math.ceil ((dataMax + margin) / step) * step;

  const ticks = [];
  // Use integer loop counter to avoid floating-point accumulation
  const nSteps = Math.round((axisMax - axisMin) / step);
  for (let i = 0; i <= nSteps; i++) {
    const v = axisMin + i * step;
    ticks.push(Math.round(v * 10) / 10); // round to 1 decimal to kill fp noise
  }

  return { ticks, axisMin, axisMax };
}

// ─── X-axis tick computation ──────────────────────────────────────────────────
//
// Returns an array of Date objects aligned to clean clock hours (0, 3, 6 … 21)
// that fall within [winStart, winEnd].

function computeXTicks(winStart, winEnd) {
  const ticks = [];
  // Start from the first 3-hour boundary at or after winStart
  const d = new Date(winStart);
  d.setMinutes(0, 0, 0);
  // Step forward to the next 3-hour mark if we're not already on one
  const h = d.getHours();
  const nextH = Math.ceil(h / 3) * 3;
  if (nextH !== h) d.setHours(nextH);

  while (d <= winEnd) {
    if (d >= winStart) ticks.push(new Date(d));
    d.setHours(d.getHours() + 3);
  }
  return ticks;
}

// ─── NOAA fetch ───────────────────────────────────────────────────────────────

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

// ─── Load tide data (centered window now−12h … now+12h) ──────────────────────

async function loadTideData(station) {
  const now = new Date();

  const winStart = new Date(now.getTime() - 12 * 60 * 60 * 1000);
  const winEnd   = new Date(now.getTime() + 12 * 60 * 60 * 1000);

  // Buffer a full day on each side so curve never runs dry at edges
  const fetchStart = new Date(winStart);
  fetchStart.setDate(fetchStart.getDate() - 1);
  const fetchEnd = new Date(winEnd);
  fetchEnd.setDate(fetchEnd.getDate() + 1);

  const [curveData, hiloData] = await Promise.all([
    fetchNoaa(station.id, toNoaaDate(fetchStart), toNoaaDate(fetchEnd), '6'),
    fetchNoaa(station.id, toNoaaDate(fetchStart), toNoaaDate(fetchEnd), 'hilo'),
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

// Expose data accessors for future scrolling module
window.tw = window.tw || {};
window.tw.loadTideData   = loadTideData;
window.tw.getTidePoints  = () => tidePoints;
window.tw.getHiloPoints  = () => hiloPoints;

// ─── Canvas setup ─────────────────────────────────────────────────────────────

function setupCanvas() {
  const container = canvas.parentElement;
  const dpr  = window.devicePixelRatio || 1;
  const cssW = container.clientWidth;
  const cssH = Math.round(cssW * 0.54);

  canvas.style.width  = cssW + 'px';
  canvas.style.height = cssH + 'px';
  canvas.width  = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  return { w: cssW, h: cssH };
}

// ─── Interpolate tide height at an arbitrary time ─────────────────────────────

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

// ─── Chart renderer ───────────────────────────────────────────────────────────

function drawChart() {
  if (!tidePoints.length) return;

  const { w, h } = setupCanvas();

  // Margins: left wide for y labels + "ft" unit; top for hilo annotations above plot
  const pad = { top: 38, right: 20, bottom: 46, left: 58 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top  - pad.bottom;

  // ── Time window centered on now ───────────────────────────────────────────
  const now      = new Date();
  const winStart = new Date(now.getTime() - 12 * 60 * 60 * 1000);
  const winEnd   = new Date(now.getTime() + 12 * 60 * 60 * 1000);
  const winSpan  = winEnd - winStart;

  // Visible curve points + one extra point on each side for bezier continuity
  const visible = tidePoints.filter(p => p.t >= winStart && p.t <= winEnd);
  const idxFirst = tidePoints.findIndex(p => p.t >= winStart);
  const idxLast  = tidePoints.findIndex(p => p.t > winEnd);
  const extStart = idxFirst > 0 ? tidePoints[idxFirst - 1] : null;
  const extEnd   = idxLast  > 0 ? tidePoints[idxLast]      : null;
  const curve    = [extStart, ...visible, extEnd].filter(Boolean);

  if (visible.length < 2) {
    showChartError('Not enough tide data for the current window. Try reloading.');
    return;
  }

  // ── Y scale: clean ticks computed from full dataset range ─────────────────
  const allV = tidePoints.map(p => p.v);
  const dataMin = Math.min(...allV);
  const dataMax = Math.max(...allV);
  const { ticks: yTicks, axisMin: yMin, axisMax: yMax } = computeYTicks(dataMin, dataMax);

  // ── X ticks: clock-aligned 3-hour boundaries ──────────────────────────────
  const xTicks = computeXTicks(winStart, winEnd);

  // ── Coordinate mappers ────────────────────────────────────────────────────
  const xOf = t => pad.left + ((t - winStart) / winSpan) * plotW;
  const yOf = v => pad.top  + (1 - (v - yMin) / (yMax - yMin)) * plotH;

  // ── Clear + background ────────────────────────────────────────────────────
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = C.navyMid;
  ctx.fillRect(0, 0, w, h);

  // ── Horizontal grid lines + y-axis tick labels ────────────────────────────
  ctx.save();
  ctx.strokeStyle  = C.gridLine;
  ctx.lineWidth    = 1;
  ctx.setLineDash([4, 7]);

  yTicks.forEach(v => {
    const y = yOf(v);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();

    // Format: whole numbers as integers, halves as x.5
    const label = Number.isInteger(v) ? String(v) : v.toFixed(1);
    ctx.fillStyle    = C.textSecond;
    ctx.font         = '12px "DM Mono", monospace';
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, pad.left - 8, y);
  });

  ctx.restore();

  // ── "ft" unit label — left of axis, above the topmost tick ───────────────
  // Placed at x = pad.left − 8, y just above the top tick line
  ctx.save();
  const topTickY = yOf(yTicks[yTicks.length - 1]); // highest value = smallest y
  ctx.fillStyle    = C.textMuted;
  ctx.font         = '11px "DM Mono", monospace';
  ctx.textAlign    = 'right';
  ctx.textBaseline = 'bottom';
  // Sit 14px above the top tick label (which is centered on topTickY)
  // That keeps at least half a line-height of separation
  ctx.fillText('ft', pad.left - 8, topTickY - 8);
  ctx.restore();

  // ── Vertical grid lines + x-axis tick marks + time labels ───────────────
  ctx.save();

  xTicks.forEach(t => {
    const x = xOf(t);

    // Dashed grid line through the plot interior
    ctx.strokeStyle = C.gridLine;
    ctx.lineWidth   = 1;
    ctx.setLineDash([2, 9]);
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, pad.top + plotH);
    ctx.stroke();

    // Short solid tick mark below the plot border, connecting border to label
    ctx.strokeStyle = C.textMuted;
    ctx.lineWidth   = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x, pad.top + plotH);
    ctx.lineTo(x, pad.top + plotH + 5);
    ctx.stroke();

    // Time label below the tick
    ctx.fillStyle    = C.textMuted;
    ctx.font         = '12px "DM Mono", monospace';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(fmtHourLabel(t), x, pad.top + plotH + 7);
  });

  ctx.restore();

  // ── Clip to plot area — keeps bezier overshoot and hilo dots inside ───────
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

  ctx.restore(); // end clip

  // ── Plot border ───────────────────────────────────────────────────────────
  ctx.save();
  ctx.strokeStyle = C.navyLight;
  ctx.lineWidth   = 1;
  ctx.setLineDash([]);
  ctx.strokeRect(pad.left, pad.top, plotW, plotH);
  ctx.restore();

  // ── High / Low tide labels ────────────────────────────────────────────────
  const visibleHilo = hiloPoints.filter(p => p.t >= winStart && p.t <= winEnd);

  // Collision registry — each entry {xMin, xMax, yMin, yMax}
  const occupied = [];

  function overlaps(r) {
    return occupied.some(o =>
      r.xMin < o.xMax && r.xMax > o.xMin &&
      r.yMin < o.yMax && r.yMax > o.yMin
    );
  }

  const LBL_HALF_W = 50;  // half-width of label column
  const LBL_H      = 32;  // two lines at ~16px each
  const DOT_R      = 4;
  const GAP        = 6;   // dot-edge to label gap

  visibleHilo.forEach(p => {
    const px = xOf(p.t);
    const py = yOf(p.v);
    const isHigh    = p.type === 'H';
    const txtColor  = isHigh ? C.hiLabel : C.loLabel;
    const heightTxt = `${p.v.toFixed(1)} ft`;
    const timeTxt   = fmtTimeExact(p.t);

    // Dot on the curve
    ctx.save();
    ctx.beginPath();
    ctx.arc(px, py, DOT_R, 0, Math.PI * 2);
    ctx.fillStyle   = txtColor;
    ctx.strokeStyle = C.navyMid;
    ctx.lineWidth   = 2;
    ctx.setLineDash([]);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Clamp label x-center to stay inside plot area
    const cx = Math.max(pad.left + LBL_HALF_W + 2,
                 Math.min(px, pad.left + plotW - LBL_HALF_W - 2));

    function tryPlace(above) {
      // labelY = top edge of the two-line label block
      const labelY = above
        ? py - DOT_R - GAP - LBL_H
        : py + DOT_R + GAP;

      const r = { xMin: cx - LBL_HALF_W, xMax: cx + LBL_HALF_W,
                  yMin: labelY,           yMax: labelY + LBL_H };

      // Allow labels to escape into the top margin (pad.top space),
      // but not above the canvas top or below the plot bottom
      if (r.yMin < 2)               return null;
      if (r.yMax > pad.top + plotH) return null;
      if (overlaps(r))              return null;
      return { labelY, r };
    }

    const preferAbove = isHigh;
    const placement =
      tryPlace(preferAbove) ||
      tryPlace(!preferAbove) ||
      // Force-place (last resort) — at least keep it the right side
      { labelY: preferAbove
          ? py - DOT_R - GAP - LBL_H
          : py + DOT_R + GAP,
        r: null };

    if (placement.r) occupied.push(placement.r);

    ctx.save();
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';

    ctx.font      = '500 13px "DM Mono", monospace';
    ctx.fillStyle = txtColor;
    ctx.fillText(heightTxt, cx, placement.labelY);

    ctx.font      = '12px "DM Mono", monospace';
    ctx.fillStyle = C.textSecond;
    ctx.fillText(timeTxt, cx, placement.labelY + 16);

    ctx.restore();
  });

  // ── "Now" marker — drawn last, above all other elements ──────────────────
  const nowX = xOf(now);

  ctx.save();

  // Dashed vertical line through plot
  ctx.strokeStyle = C.nowLine;
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.lineCap     = 'butt';
  ctx.beginPath();
  ctx.moveTo(nowX, pad.top);
  ctx.lineTo(nowX, pad.top + plotH);
  ctx.stroke();

  // Dot on the tide curve at the current moment
  const nowV = interpolateAtTime(now);
  if (nowV !== null) {
    const nowY = yOf(nowV);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(nowX, nowY, 5, 0, Math.PI * 2);
    ctx.fillStyle   = C.nowDot;
    ctx.strokeStyle = C.navyMid;
    ctx.lineWidth   = 2;
    ctx.fill();
    ctx.stroke();
  }

  // "now" label above the plot area, centered on the now line
  // Clamp so it doesn't clip behind the y-axis
  const nowLabelX = Math.max(nowX, pad.left + 20);
  ctx.setLineDash([]);
  ctx.font         = '500 12px "DM Mono", monospace';
  ctx.fillStyle    = C.textPrimary;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText('now', nowLabelX, pad.top - 5);

  ctx.restore();
}

// ─── Update chart header ──────────────────────────────────────────────────────

function updateHeader() {
  const now      = new Date();
  const winStart = new Date(now.getTime() - 12 * 60 * 60 * 1000);
  const winEnd   = new Date(now.getTime() + 12 * 60 * 60 * 1000);

  if (winStart.toDateString() === winEnd.toDateString()) {
    chartDateLabel.textContent = fmtDateFull(now);
  } else {
    // Window crosses midnight — show date range
    chartDateLabel.textContent =
      `${fmtDateShort(winStart)} – ${fmtDateShort(winEnd)}`;
  }
}

// ─── Show chart ───────────────────────────────────────────────────────────────

function showChart(station) {
  updateHeader();
  hideChartStatus();
  chartCard.classList.remove('hidden');
  drawChart();
}

// ─── Station selection event ──────────────────────────────────────────────────

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
