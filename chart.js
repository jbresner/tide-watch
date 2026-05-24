/**
 * TideWatch — chart.js  v1.8
 *
 * Changes from v1.7:
 *  - Continuous horizontal timeline — drag/swipe to scroll through time
 *  - viewOffset: ms offset from "now", updated by touch interaction
 *  - Inertia / momentum scrolling with exponential decay
 *  - Chunked NOAA data loading — 5-day slabs, lazy-fetched as window nears edges
 *  - Y-axis fixed: drawn as opaque overlay strip after scrolling content
 *  - X-axis moves with scroll: labels recomputed each frame from visible window
 *  - Now marker stays at the correct position as the timeline scrolls
 *  - Y-axis left padding nudged from 44→50 (mobile), 52→58 (desktop)
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

// ─── Canvas palette ───────────────────────────────────────────────────────────

const C = {
  navy:        '#0b1622',
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

// ─── Timeline state ───────────────────────────────────────────────────────────

// viewOffset: milliseconds the view is shifted from "now"
// 0 = centered on now (default)
// positive = looking into the future
// negative = looking into the past
let viewOffset = 0;

// The real wall-clock "now" — captured once when chart loads, used as the
// fixed reference point so the now marker doesn't drift during a session.
let sessionNow = new Date();

// ─── Tide data store ──────────────────────────────────────────────────────────

let tidePoints  = [];  // {t: Date, v: number}[] — sorted ascending
let hiloPoints  = [];  // {t: Date, v: number, type:'H'|'L'}[] — sorted ascending
let stationInfo = null;

// Loaded date ranges (as day-boundary timestamps for deduplication)
// Each entry: {start: Date, end: Date}
const loadedChunks = [];
let fetchInFlight  = false;

// ─── Y scale — computed once from loaded data, stable during scroll ───────────
let yScaleCache = null; // {ticks, axisMin, axisMax, yMin, yMax}

// ─── Status helpers ───────────────────────────────────────────────────────────

function setChartStatus(state, headline, detail) {
  chartStatusCard.classList.remove('hidden');
  chartStatusIcon.className = `status-${state}`;
  chartStatusHLine.textContent = headline;
  chartStatusDetail.textContent = detail;
}

function hideChartStatus() { chartStatusCard.classList.add('hidden'); }

function showChartError(msg) {
  hideChartStatus();
  chartCard.classList.add('hidden');
  chartErrorCard.classList.remove('hidden');
  chartErrorDetail.textContent = msg;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function toNoaaDate(d) {
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}

function parseNoaaTime(str) { return new Date(str.replace(' ', 'T')); }

// Compact axis label: "12a" "3p" etc.
function fmtAxisLabel(d) {
  const h = d.getHours();
  if (h === 0)  return '12a';
  if (h === 12) return '12p';
  return h < 12 ? `${h}a` : `${h - 12}p`;
}

// Full time for hilo annotations
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

function computeYTicks(dataMin, dataMax) {
  const range = dataMax - dataMin;
  let step;
  if      (range <= 3)  step = 0.5;
  else if (range <= 8)  step = 1;
  else if (range <= 16) step = 2;
  else                  step = 5;

  const margin  = step * 0.5;
  const axisMin = Math.floor((dataMin - margin) / step) * step;
  const axisMax = Math.ceil ((dataMax + margin) / step) * step;

  const nSteps = Math.round((axisMax - axisMin) / step);
  const ticks  = [];
  for (let i = 0; i <= nSteps; i++) {
    ticks.push(Math.round((axisMin + i * step) * 10) / 10);
  }
  return { ticks, axisMin, axisMax };
}

// ─── X-axis tick computation ──────────────────────────────────────────────────

function computeXTicks(winStart, winEnd, plotW) {
  const stepHours = plotW < 280 ? 6 : 3;
  const ticks = [];
  const d = new Date(winStart);
  d.setMinutes(0, 0, 0);
  const h = d.getHours();
  const rem = h % stepHours;
  if (rem !== 0) d.setHours(h + (stepHours - rem));
  if (d.getHours() === 0 && rem !== 0) {} // midnight roll handled by Date

  while (d <= winEnd) {
    if (d >= winStart) ticks.push(new Date(d));
    d.setHours(d.getHours() + stepHours);
  }
  return ticks;
}

// ─── NOAA fetch ───────────────────────────────────────────────────────────────

async function fetchNoaa(stationId, beginDate, endDate, interval) {
  const params = new URLSearchParams({
    ...NOAA_BASE, station: stationId,
    begin_date: beginDate, end_date: endDate, interval,
  });
  const res  = await fetch(`${NOAA_DATA_URL}?${params}`);
  if (!res.ok) throw new Error(`NOAA HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'NOAA API error');
  return data;
}

// ─── Chunked data loading ─────────────────────────────────────────────────────
//
// Strategy: load in 5-day slabs. Track what we've loaded.
// When the visible window is within PREFETCH_DAYS of a loaded edge,
// start fetching the next slab silently in the background.

const CHUNK_DAYS    = 5;   // days per NOAA fetch
const PREFETCH_DAYS = 2;   // trigger prefetch when this close to edge

function dayFloor(d) {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

function dayOffset(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

// Is a given date covered by our loaded chunks?
function isCovered(t) {
  return loadedChunks.some(c => t >= c.start && t <= c.end);
}

// Merge new points into sorted arrays (deduplicate by timestamp)
function mergePoints(existing, incoming) {
  const map = new Map(existing.map(p => [p.t.getTime(), p]));
  for (const p of incoming) map.set(p.t.getTime(), p);
  return [...map.values()].sort((a, b) => a.t - b.t);
}

async function fetchChunk(station, chunkStart, chunkEnd) {
  if (fetchInFlight) return;
  // Don't re-fetch a range we already have
  if (isCovered(chunkStart) && isCovered(dayOffset(chunkEnd, -1))) return;

  fetchInFlight = true;
  console.log(`[TideWatch] Fetching chunk ${toNoaaDate(chunkStart)}–${toNoaaDate(chunkEnd)}`);

  try {
    const [curveData, hiloData] = await Promise.all([
      fetchNoaa(station.id, toNoaaDate(chunkStart), toNoaaDate(chunkEnd), '6'),
      fetchNoaa(station.id, toNoaaDate(chunkStart), toNoaaDate(chunkEnd), 'hilo'),
    ]);

    const newCurve = (curveData.predictions || []).map(p => ({
      t: parseNoaaTime(p.t), v: parseFloat(p.v),
    }));
    const newHilo = (hiloData.predictions || []).map(p => ({
      t: parseNoaaTime(p.t), v: parseFloat(p.v), type: p.type,
    }));

    tidePoints = mergePoints(tidePoints, newCurve);
    hiloPoints = mergePoints(hiloPoints, newHilo);

    loadedChunks.push({ start: chunkStart, end: chunkEnd });

    // Recompute Y scale to include new data range
    rebuildYScale();

    console.log(`[TideWatch] Now have ${tidePoints.length} pts, ${hiloPoints.length} hilo`);
  } catch (err) {
    console.warn('[TideWatch] Chunk fetch failed:', err.message);
  } finally {
    fetchInFlight = false;
  }
}

// Initial load: covers now−2d … now+3d (5-day chunk centered on today)
async function initialLoad(station) {
  const center = dayFloor(sessionNow);
  const start  = dayOffset(center, -2);
  const end    = dayOffset(center, +3);
  await fetchChunk(station, start, end);
}

// Called each draw — ensures data exists for the current window,
// and prefetches ahead/behind as needed. Fire-and-forget.
function ensureData(winStart, winEnd) {
  if (!stationInfo) return;

  const prefetchAhead = new Date(winEnd.getTime()  + PREFETCH_DAYS * 86400000);
  const prefetchBehind = new Date(winStart.getTime() - PREFETCH_DAYS * 86400000);

  if (!isCovered(prefetchAhead)) {
    const cs = dayFloor(winEnd);
    const ce = dayOffset(cs, CHUNK_DAYS);
    fetchChunk(stationInfo, cs, ce);
  }

  if (!isCovered(prefetchBehind)) {
    const ce = dayFloor(winStart);
    const cs = dayOffset(ce, -CHUNK_DAYS);
    fetchChunk(stationInfo, cs, ce);
  }
}

// ─── Y scale cache ────────────────────────────────────────────────────────────

function rebuildYScale() {
  if (!tidePoints.length) return;
  const allV = tidePoints.map(p => p.v);
  const { ticks, axisMin, axisMax } = computeYTicks(Math.min(...allV), Math.max(...allV));
  yScaleCache = { ticks, yMin: axisMin, yMax: axisMax };
}

// ─── Canvas setup ─────────────────────────────────────────────────────────────

function setupCanvas() {
  const container = canvas.parentElement;
  const dpr  = window.devicePixelRatio || 1;
  const cssW = container.clientWidth;
  const ratio = cssW < 340 ? 0.70 : cssW < 420 ? 0.62 : 0.54;
  const cssH  = Math.round(cssW * ratio);

  canvas.style.width  = cssW + 'px';
  canvas.style.height = cssH + 'px';
  canvas.width  = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  return { w: cssW, h: cssH };
}

// ─── Interpolate tide height ──────────────────────────────────────────────────

function interpolateAtTime(t) {
  if (!tidePoints.length) return null;
  const ts = t.getTime();
  for (let i = 1; i < tidePoints.length; i++) {
    const a = tidePoints[i-1], b = tidePoints[i];
    if (ts >= a.t.getTime() && ts <= b.t.getTime()) {
      return a.v + (ts - a.t.getTime()) / (b.t.getTime() - a.t.getTime()) * (b.v - a.v);
    }
  }
  return null;
}

// ─── Main draw function ───────────────────────────────────────────────────────

function drawChart() {
  if (!tidePoints.length || !yScaleCache) return;

  const { w, h } = setupCanvas();

  const isMobile = w < 420;

  // Y-axis left padding nudged: mobile 44→50, desktop 52→58
  const pad = {
    top:    isMobile ? 34 : 38,
    right:  isMobile ? 12 : 20,
    bottom: isMobile ? 40 : 46,
    left:   isMobile ? 50 : 58,
  };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top  - pad.bottom;

  // ── Compute visible window from viewOffset ────────────────────────────────
  const center   = new Date(sessionNow.getTime() + viewOffset);
  const winStart = new Date(center.getTime() - 12 * 60 * 60 * 1000);
  const winEnd   = new Date(center.getTime() + 12 * 60 * 60 * 1000);
  const winSpan  = winEnd.getTime() - winStart.getTime();

  // Trigger background data loads if needed (fire-and-forget)
  ensureData(winStart, winEnd);

  // ── Build curve array (visible + 1 extension point each side) ────────────
  const idxFirst = tidePoints.findIndex(p => p.t >= winStart);
  const idxLast  = tidePoints.findIndex(p => p.t >  winEnd);
  if (idxFirst === -1) return; // no data in window yet

  const extStart = idxFirst > 0 ? tidePoints[idxFirst - 1] : null;
  const extEnd   = idxLast  > 0 ? tidePoints[idxLast]      : tidePoints[tidePoints.length - 1];
  const visible  = tidePoints.slice(idxFirst, idxLast > 0 ? idxLast : undefined);
  const curve    = [extStart, ...visible, extEnd].filter(Boolean);

  if (visible.length < 2) return;

  // ── Y scale (stable, from cache) ──────────────────────────────────────────
  const { ticks: yTicks, yMin, yMax } = yScaleCache;

  // ── Coordinate mappers ────────────────────────────────────────────────────
  const xOf = t  => pad.left + ((t.getTime() - winStart.getTime()) / winSpan) * plotW;
  const yOf = v  => pad.top  + (1 - (v - yMin) / (yMax - yMin)) * plotH;

  // ── Clear ─────────────────────────────────────────────────────────────────
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = C.navyMid;
  ctx.fillRect(0, 0, w, h);

  // ── Horizontal grid lines (full width, drawn behind everything) ───────────
  ctx.save();
  ctx.strokeStyle = C.gridLine;
  ctx.lineWidth   = 1;
  ctx.setLineDash([4, 7]);
  yTicks.forEach(v => {
    const y = yOf(v);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();
  });
  ctx.restore();

  // ── X-axis: vertical grid lines + ticks + labels (scrolling) ─────────────
  const xTicks    = computeXTicks(winStart, winEnd, plotW);
  const xFontSize = isMobile ? 11 : 12;
  ctx.save();
  xTicks.forEach(t => {
    const x = xOf(t);

    // Dashed grid line
    ctx.strokeStyle = C.gridLine;
    ctx.lineWidth   = 1;
    ctx.setLineDash([2, 9]);
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, pad.top + plotH);
    ctx.stroke();

    // Solid tick below plot
    ctx.strokeStyle = C.textMuted;
    ctx.lineWidth   = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x, pad.top + plotH);
    ctx.lineTo(x, pad.top + plotH + 4);
    ctx.stroke();

    // Label
    ctx.fillStyle    = C.textMuted;
    ctx.font         = `${xFontSize}px "DM Mono", monospace`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(fmtAxisLabel(t), x, pad.top + plotH + 6);
  });
  ctx.restore();

  // ── Clip to plot area ─────────────────────────────────────────────────────
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.left, pad.top, plotW, plotH);
  ctx.clip();

  // ── Filled area ───────────────────────────────────────────────────────────
  const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
  grad.addColorStop(0, C.fillTop);
  grad.addColorStop(1, C.fillBot);

  ctx.beginPath();
  ctx.moveTo(xOf(curve[0].t), yOf(curve[0].v));
  for (let i = 1; i < curve.length; i++) {
    const p = curve[i-1], q = curve[i];
    const cpx = (xOf(p.t) + xOf(q.t)) / 2;
    ctx.bezierCurveTo(cpx, yOf(p.v), cpx, yOf(q.v), xOf(q.t), yOf(q.v));
  }
  ctx.lineTo(xOf(curve[curve.length-1].t), pad.top + plotH);
  ctx.lineTo(xOf(curve[0].t), pad.top + plotH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // ── Tide line ─────────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.strokeStyle = C.tideBright;
  ctx.lineWidth   = isMobile ? 2 : 2.5;
  ctx.lineJoin    = 'round';
  ctx.lineCap     = 'round';
  ctx.setLineDash([]);
  ctx.moveTo(xOf(curve[0].t), yOf(curve[0].v));
  for (let i = 1; i < curve.length; i++) {
    const p = curve[i-1], q = curve[i];
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

  // ── High / Low annotations ────────────────────────────────────────────────
  const DOT_R      = isMobile ? 3.5 : 4;
  const GAP        = 5;
  const LBL_HALF_W = Math.round(Math.min(28, Math.max(20, plotW / 10)));
  const HT_FONT    = isMobile ? 12 : 13;
  const TM_FONT    = isMobile ? 10 : 12;
  const LBL_HT_H   = HT_FONT + 3;
  const LBL_TM_H   = TM_FONT + 2;
  const LBL_H      = LBL_HT_H + LBL_TM_H + 2;

  const visibleHilo = hiloPoints.filter(p => p.t >= winStart && p.t <= winEnd);
  const hiloXPos    = visibleHilo.map(p => xOf(p.t));
  const tightlyPacked = visibleHilo.length >= 2 &&
    hiloXPos.some((x, i) => i > 0 && Math.abs(x - hiloXPos[i-1]) < LBL_HALF_W * 2 + 4);
  const showTimeLine  = !tightlyPacked;
  const effectiveLblH = showTimeLine ? LBL_H : LBL_HT_H;

  const occupied = [];
  function overlaps(r) {
    return occupied.some(o =>
      r.xMin < o.xMax && r.xMax > o.xMin && r.yMin < o.yMax && r.yMax > o.yMin
    );
  }

  visibleHilo.forEach(p => {
    const px = xOf(p.t);
    const py = yOf(p.v);
    const isHigh   = p.type === 'H';
    const txtColor = isHigh ? C.hiLabel : C.loLabel;

    // Dot
    ctx.save();
    ctx.beginPath();
    ctx.arc(px, py, DOT_R, 0, Math.PI * 2);
    ctx.fillStyle   = txtColor;
    ctx.strokeStyle = C.navyMid;
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([]);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    const cx = Math.max(pad.left + LBL_HALF_W + 1,
                 Math.min(px, pad.left + plotW - LBL_HALF_W - 1));

    function tryPlace(above) {
      const labelY = above
        ? py - DOT_R - GAP - effectiveLblH
        : py + DOT_R + GAP;
      const r = { xMin: cx - LBL_HALF_W, xMax: cx + LBL_HALF_W,
                  yMin: labelY, yMax: labelY + effectiveLblH };
      if (r.yMin < 1 || r.yMax > pad.top + plotH || overlaps(r)) return null;
      return { labelY, r };
    }

    const placement =
      tryPlace(isHigh) || tryPlace(!isHigh) ||
      { labelY: isHigh ? py - DOT_R - GAP - effectiveLblH : py + DOT_R + GAP, r: null };

    if (placement.r) occupied.push(placement.r);

    ctx.save();
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    ctx.font         = `500 ${HT_FONT}px "DM Mono", monospace`;
    ctx.fillStyle    = txtColor;
    ctx.fillText(`${p.v.toFixed(1)} ft`, cx, placement.labelY);
    if (showTimeLine) {
      ctx.font      = `${TM_FONT}px "DM Mono", monospace`;
      ctx.fillStyle = C.textSecond;
      ctx.fillText(fmtTimeExact(p.t), cx, placement.labelY + LBL_HT_H);
    }
    ctx.restore();
  });

  // ── Now marker ────────────────────────────────────────────────────────────
  // nowX is always computed from the real sessionNow, regardless of viewOffset
  const nowX = xOf(sessionNow);

  ctx.save();
  ctx.strokeStyle = C.nowLine;
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.lineCap     = 'butt';
  ctx.beginPath();
  ctx.moveTo(nowX, pad.top);
  ctx.lineTo(nowX, pad.top + plotH);
  ctx.stroke();

  const nowV = interpolateAtTime(sessionNow);
  if (nowV !== null) {
    const nowY = yOf(nowV);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(nowX, nowY, isMobile ? 4 : 5, 0, Math.PI * 2);
    ctx.fillStyle   = C.nowDot;
    ctx.strokeStyle = C.navyMid;
    ctx.lineWidth   = 2;
    ctx.fill();
    ctx.stroke();
  }

  // "now" label — in top margin
  ctx.setLineDash([]);
  ctx.font         = `500 ${isMobile ? 11 : 12}px "DM Mono", monospace`;
  ctx.fillStyle    = C.textPrimary;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'bottom';
  // Keep label inside plot left bound
  const nowLabelX = Math.max(nowX, pad.left + 18);
  ctx.fillText('now', nowLabelX, pad.top - 4);
  ctx.restore();

  // ── Y-axis overlay — drawn LAST, covers scrolling grid lines ─────────────
  // Opaque strip from canvas left to pad.left, then y-axis labels on top.
  // This gives the fixed y-axis effect without a second canvas.
  drawYAxisOverlay(pad, plotH, plotW, yTicks, yOf, isMobile);

  // ── Update header text ────────────────────────────────────────────────────
  updateHeader(winStart, winEnd, center);
}

// ─── Fixed Y-axis overlay ─────────────────────────────────────────────────────
// Paints an opaque strip over the left margin so scrolling grid lines
// don't bleed into the y-label area. Labels are then drawn on top.

function drawYAxisOverlay(pad, plotH, plotW, yTicks, yOf, isMobile) {
  const yFontSize = isMobile ? 11 : 12;

  // Opaque background strip (matches page background, not navy-mid)
  ctx.save();
  ctx.fillStyle = C.navyMid;
  ctx.fillRect(0, 0, pad.left, pad.top + plotH + 2);
  ctx.restore();

  // Y-axis tick labels
  ctx.save();
  yTicks.forEach(v => {
    const y    = yOf(v);
    const label = Number.isInteger(v) ? String(v) : v.toFixed(1);
    ctx.fillStyle    = C.textSecond;
    ctx.font         = `${yFontSize}px "DM Mono", monospace`;
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, pad.left - 6, y);
  });
  ctx.restore();
}

// ─── Header text update ───────────────────────────────────────────────────────

function updateHeader(winStart, winEnd, center) {
  if (!center) {
    center = new Date(sessionNow.getTime() + viewOffset);
    const h12 = 12 * 60 * 60 * 1000;
    winStart = new Date(center.getTime() - h12);
    winEnd   = new Date(center.getTime() + h12);
  }
  chartDateLabel.textContent =
    winStart.toDateString() === winEnd.toDateString()
      ? fmtDateFull(center)
      : `${fmtDateShort(winStart)} – ${fmtDateShort(winEnd)}`;
}

// ─── Touch / inertia interaction ──────────────────────────────────────────────

let touch = {
  active:    false,
  startX:    0,
  startOff:  0,       // viewOffset at touch start
  lastX:     0,
  lastTime:  0,
  velX:      0,       // px/ms velocity at touchend
};

let inertiaRaf = null;

// ms of chart time per pixel — derived from canvas width and 24h window
function msPerPx() {
  const cssW = canvas.clientWidth || canvas.offsetWidth || 320;
  const isMobile = cssW < 420;
  const leftPad  = isMobile ? 50 : 58;
  const rightPad = isMobile ? 12 : 20;
  const plotW    = cssW - leftPad - rightPad;
  return (24 * 60 * 60 * 1000) / plotW; // 24h window / plot pixels
}

function cancelInertia() {
  if (inertiaRaf) { cancelAnimationFrame(inertiaRaf); inertiaRaf = null; }
}

function startInertia(velPxPerMs) {
  // velPxPerMs: positive = dragged right (going into past), negative = future
  const FRICTION = 0.96; // velocity multiplier per 16ms frame
  const MIN_VEL  = 0.04; // px/ms below which we stop

  let vel = velPxPerMs;

  function step() {
    vel *= FRICTION;
    if (Math.abs(vel) < MIN_VEL) { inertiaRaf = null; return; }

    viewOffset -= vel * msPerPx() * 16;
    drawChart();
    inertiaRaf = requestAnimationFrame(step);
  }

  inertiaRaf = requestAnimationFrame(step);
}

canvas.addEventListener('touchstart', e => {
  cancelInertia();
  const t = e.touches[0];
  touch.active   = true;
  touch.startX   = t.clientX;
  touch.startOff = viewOffset;
  touch.lastX    = t.clientX;
  touch.lastTime = e.timeStamp;
  touch.velX     = 0;
}, { passive: true });

canvas.addEventListener('touchmove', e => {
  if (!touch.active) return;
  e.preventDefault(); // prevent page scroll while scrubbing chart

  const t   = e.touches[0];
  const dx  = t.clientX - touch.startX; // px moved since touch start
  viewOffset = touch.startOff - dx * msPerPx();

  // Track instantaneous velocity for inertia (exponential moving average)
  const dt = e.timeStamp - touch.lastTime;
  if (dt > 0) {
    const instVel = (t.clientX - touch.lastX) / dt;
    touch.velX    = touch.velX * 0.6 + instVel * 0.4;
  }
  touch.lastX    = t.clientX;
  touch.lastTime = e.timeStamp;

  drawChart();
}, { passive: false });

canvas.addEventListener('touchend', e => {
  if (!touch.active) return;
  touch.active = false;

  // Only trigger inertia if final velocity is meaningful
  if (Math.abs(touch.velX) > 0.1) {
    startInertia(touch.velX);
  }
}, { passive: true });

// ─── Show chart ───────────────────────────────────────────────────────────────

function showChart() {
  updateHeader();
  hideChartStatus();
  chartCard.classList.remove('hidden');
  drawChart();
}

// ─── Station selection ────────────────────────────────────────────────────────

document.addEventListener('stationSelected', async (e) => {
  stationInfo  = e.detail;
  sessionNow   = new Date();
  viewOffset   = 0;
  tidePoints   = [];
  hiloPoints   = [];
  yScaleCache  = null;
  loadedChunks.length = 0;

  chartSection.classList.remove('hidden');
  setChartStatus('loading', 'Loading tide data', `Fetching predictions for ${stationInfo.name}…`);

  try {
    await initialLoad(stationInfo);
    showChart();
  } catch (err) {
    console.error('[TideWatch] Tide data error:', err);
    showChartError(err.message);
  }
});

// ─── Resize ───────────────────────────────────────────────────────────────────

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!chartCard.classList.contains('hidden')) drawChart();
  }, 120);
});

// ─── Public API for future modules ───────────────────────────────────────────

window.tw = window.tw || {};
window.tw.getViewOffset  = () => viewOffset;
window.tw.setViewOffset  = (ms) => { viewOffset = ms; drawChart(); };
window.tw.getTidePoints  = () => tidePoints;
window.tw.getHiloPoints  = () => hiloPoints;
window.tw.getSessionNow  = () => sessionNow;
