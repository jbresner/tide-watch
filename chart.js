/**
 * TideWatch — chart.js  v1.5
 *
 * Changes from v1.4:
 *  - Adaptive x-axis: fewer compact labels on narrow screens (12a/6a/12p/6p)
 *  - Compact label format: "12a" "3p" instead of "12 AM" "3 PM"
 *  - Removed "ft" y-axis unit label (moved to HTML chart-meta footer)
 *  - Adaptive annotations: font + collision zones scale with plotW
 *  - Height-only fallback when time label won't fit
 *  - Tighter card padding on mobile via CSS; canvas height ratio adjusts for narrow screens
 *  - Station card: distance and coords removed
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

let tidePoints  = [];
let hiloPoints  = [];
let stationInfo = null;

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

/**
 * Compact axis label: "12a", "3p", "6a", "9p"
 * Midnight = "12a", Noon = "12p", others = hour + a/p (no leading zero)
 */
function fmtAxisLabel(d) {
  const h = d.getHours();
  if (h === 0)  return '12a';
  if (h === 12) return '12p';
  return h < 12 ? `${h}a` : `${h - 12}p`;
}

/** Full time for hilo annotations: "2:34 PM" */
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

  const margin = step * 0.5;
  const axisMin = Math.floor((dataMin - margin) / step) * step;
  const axisMax = Math.ceil ((dataMax + margin) / step) * step;

  const nSteps = Math.round((axisMax - axisMin) / step);
  const ticks = [];
  for (let i = 0; i <= nSteps; i++) {
    ticks.push(Math.round((axisMin + i * step) * 10) / 10);
  }
  return { ticks, axisMin, axisMax };
}

// ─── X-axis tick computation ──────────────────────────────────────────────────
//
// Picks a 3-hour or 6-hour step depending on available horizontal space.
// Minimum comfortable label width ≈ 28px for "12a" at 11px mono.
// 24-hour window across plotW pixels → px-per-hour = plotW/24.
// 3h step → labels every plotW/8 px. At 280px plotW that's 35px — ok.
// At 240px plotW that's 30px — marginal; switch to 6h step (60px gap).
// Threshold: use 6h step when plotW < 280.

function computeXTicks(winStart, winEnd, plotW) {
  const stepHours = plotW < 280 ? 6 : 3;

  const ticks = [];
  const d = new Date(winStart);
  d.setMinutes(0, 0, 0);
  const h = d.getHours();
  const nextH = Math.ceil(h / stepHours) * stepHours;
  if (nextH !== h) d.setHours(nextH % 24);
  // handle day roll-over when nextH >= 24
  if (nextH >= 24) d.setDate(d.getDate() + 1);

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
  const url = `${NOAA_DATA_URL}?${params}`;
  console.log(`[TideWatch] fetch interval=${interval}`, url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`NOAA HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'NOAA API error');
  return data;
}

// ─── Load tide data ───────────────────────────────────────────────────────────

async function loadTideData(station) {
  const now      = new Date();
  const winStart = new Date(now.getTime() - 12 * 60 * 60 * 1000);
  const winEnd   = new Date(now.getTime() + 12 * 60 * 60 * 1000);

  const fetchStart = new Date(winStart); fetchStart.setDate(fetchStart.getDate() - 1);
  const fetchEnd   = new Date(winEnd);   fetchEnd.setDate(fetchEnd.getDate() + 1);

  const [curveData, hiloData] = await Promise.all([
    fetchNoaa(station.id, toNoaaDate(fetchStart), toNoaaDate(fetchEnd), '6'),
    fetchNoaa(station.id, toNoaaDate(fetchStart), toNoaaDate(fetchEnd), 'hilo'),
  ]);

  tidePoints = (curveData.predictions || []).map(p => ({ t: parseNoaaTime(p.t), v: parseFloat(p.v) }));
  hiloPoints = (hiloData.predictions  || []).map(p => ({ t: parseNoaaTime(p.t), v: parseFloat(p.v), type: p.type }));

  console.log(`[TideWatch] ${tidePoints.length} curve pts, ${hiloPoints.length} hilo events`);
}

window.tw = window.tw || {};
window.tw.loadTideData  = loadTideData;
window.tw.getTidePoints = () => tidePoints;
window.tw.getHiloPoints = () => hiloPoints;

// ─── Canvas setup ─────────────────────────────────────────────────────────────

function setupCanvas() {
  const container = canvas.parentElement;
  const dpr  = window.devicePixelRatio || 1;
  const cssW = container.clientWidth;
  // Taller aspect ratio on narrow screens so annotations have room
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

// ─── Chart renderer ───────────────────────────────────────────────────────────

function drawChart() {
  if (!tidePoints.length) return;

  const { w, h } = setupCanvas();

  // ── Adaptive margins based on screen width ────────────────────────────────
  // Narrower left on mobile since y-labels are shorter; keep top for annotations
  const isMobile = w < 420;
  const pad = {
    top:    isMobile ? 34 : 38,
    right:  isMobile ? 12 : 20,
    bottom: isMobile ? 40 : 46,
    left:   isMobile ? 44 : 52,
  };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top  - pad.bottom;

  // ── Window ────────────────────────────────────────────────────────────────
  const now      = new Date();
  const winStart = new Date(now.getTime() - 12 * 60 * 60 * 1000);
  const winEnd   = new Date(now.getTime() + 12 * 60 * 60 * 1000);
  const winSpan  = winEnd - winStart;

  const visible  = tidePoints.filter(p => p.t >= winStart && p.t <= winEnd);
  const idxFirst = tidePoints.findIndex(p => p.t >= winStart);
  const idxLast  = tidePoints.findIndex(p => p.t > winEnd);
  const extStart = idxFirst > 0 ? tidePoints[idxFirst - 1] : null;
  const extEnd   = idxLast  > 0 ? tidePoints[idxLast]      : null;
  const curve    = [extStart, ...visible, extEnd].filter(Boolean);

  if (visible.length < 2) {
    showChartError('Not enough tide data for this window. Try reloading.');
    return;
  }

  // ── Y scale ───────────────────────────────────────────────────────────────
  const allV = tidePoints.map(p => p.v);
  const { ticks: yTicks, axisMin: yMin, axisMax: yMax } =
    computeYTicks(Math.min(...allV), Math.max(...allV));

  // ── X ticks — width-aware ─────────────────────────────────────────────────
  const xTicks = computeXTicks(winStart, winEnd, plotW);

  // ── Coordinate mappers ────────────────────────────────────────────────────
  const xOf = t => pad.left + ((t - winStart) / winSpan) * plotW;
  const yOf = v => pad.top  + (1 - (v - yMin) / (yMax - yMin)) * plotH;

  // ── Clear + background ────────────────────────────────────────────────────
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = C.navyMid;
  ctx.fillRect(0, 0, w, h);

  // ── Horizontal grid + y-axis labels ──────────────────────────────────────
  const yFontSize = isMobile ? 11 : 12;
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

    const label = Number.isInteger(v) ? String(v) : v.toFixed(1);
    ctx.fillStyle    = C.textSecond;
    ctx.font         = `${yFontSize}px "DM Mono", monospace`;
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, pad.left - 6, y);
  });
  ctx.restore();

  // ── Vertical grid lines + tick marks + x-axis labels ─────────────────────
  const xFontSize = isMobile ? 11 : 12;
  ctx.save();

  xTicks.forEach(t => {
    const x = xOf(t);

    // Dashed vertical grid line
    ctx.strokeStyle = C.gridLine;
    ctx.lineWidth   = 1;
    ctx.setLineDash([2, 9]);
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, pad.top + plotH);
    ctx.stroke();

    // Solid tick mark below plot border
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

  // ── Clip region ───────────────────────────────────────────────────────────
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.left, pad.top, plotW, plotH);
  ctx.clip();

  // ── Fill ──────────────────────────────────────────────────────────────────
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

  // ── High / Low tide annotations ───────────────────────────────────────────
  //
  // Scale annotation geometry to plotW so mobile labels don't collide.
  // At 260px plotW a label block is ~44px wide (half = 22px).
  // At 380px plotW it's ~48px (half = 24px). Clamp between 20–28.
  const DOT_R      = isMobile ? 3.5 : 4;
  const GAP        = 5;
  const LBL_HALF_W = Math.round(Math.min(28, Math.max(20, plotW / 10)));
  const HT_FONT    = isMobile ? 12 : 13;  // height value font size
  const TM_FONT    = isMobile ? 10 : 12;  // time font size
  const LBL_HT_H   = HT_FONT + 3;        // height line height
  const LBL_TM_H   = TM_FONT + 2;        // time line height
  const LBL_H      = LBL_HT_H + LBL_TM_H + 2; // total two-line block

  // Minimum horizontal gap between label centers before we drop time line
  // Approx: each label is LBL_HALF_W*2 wide; labels need >4px between them
  const minLabelSpacing = LBL_HALF_W * 2 + 4;

  // Collision registry
  const occupied = [];
  function overlaps(r) {
    return occupied.some(o =>
      r.xMin < o.xMax && r.xMax > o.xMin && r.yMin < o.yMax && r.yMax > o.yMin
    );
  }

  const visibleHilo = hiloPoints.filter(p => p.t >= winStart && p.t <= winEnd);

  // Pre-check x spacing between consecutive hilo labels — if too tight, suppress time
  const hiloXPositions = visibleHilo.map(p => xOf(p.t));
  const tightlyPacked  = visibleHilo.length >= 2 &&
    hiloXPositions.some((x, i) =>
      i > 0 && Math.abs(x - hiloXPositions[i-1]) < minLabelSpacing
    );
  const showTimeLine = !tightlyPacked;

  // Effective label block height depends on whether we show time
  const effectiveLblH = showTimeLine ? LBL_H : LBL_HT_H;

  visibleHilo.forEach(p => {
    const px = xOf(p.t);
    const py = yOf(p.v);
    const isHigh   = p.type === 'H';
    const txtColor = isHigh ? C.hiLabel : C.loLabel;
    const heightTxt = `${p.v.toFixed(1)} ft`;
    const timeTxt   = fmtTimeExact(p.t);

    // Dot on the curve
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

    // Clamp label center within plot bounds
    const cx = Math.max(pad.left + LBL_HALF_W + 1,
                 Math.min(px, pad.left + plotW - LBL_HALF_W - 1));

    function tryPlace(above) {
      const labelY = above
        ? py - DOT_R - GAP - effectiveLblH
        : py + DOT_R + GAP;
      const r = {
        xMin: cx - LBL_HALF_W, xMax: cx + LBL_HALF_W,
        yMin: labelY,           yMax: labelY + effectiveLblH,
      };
      // Allow into top margin but not off top of canvas, and not below plot bottom
      if (r.yMin < 1)               return null;
      if (r.yMax > pad.top + plotH) return null;
      if (overlaps(r))              return null;
      return { labelY, r };
    }

    const preferAbove = isHigh;
    const placement =
      tryPlace(preferAbove) ||
      tryPlace(!preferAbove) ||
      { labelY: preferAbove
          ? py - DOT_R - GAP - effectiveLblH
          : py + DOT_R + GAP,
        r: null };

    if (placement.r) occupied.push(placement.r);

    ctx.save();
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';

    // Height value — always shown
    ctx.font      = `500 ${HT_FONT}px "DM Mono", monospace`;
    ctx.fillStyle = txtColor;
    ctx.fillText(heightTxt, cx, placement.labelY);

    // Time — only when spacing permits
    if (showTimeLine) {
      ctx.font      = `${TM_FONT}px "DM Mono", monospace`;
      ctx.fillStyle = C.textSecond;
      ctx.fillText(timeTxt, cx, placement.labelY + LBL_HT_H);
    }

    ctx.restore();
  });

  // ── "Now" marker ──────────────────────────────────────────────────────────
  const nowX = xOf(now);

  ctx.save();

  // Dashed line
  ctx.strokeStyle = C.nowLine;
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.lineCap     = 'butt';
  ctx.beginPath();
  ctx.moveTo(nowX, pad.top);
  ctx.lineTo(nowX, pad.top + plotH);
  ctx.stroke();

  // Dot on curve
  const nowV = interpolateAtTime(now);
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

  // "now" label — clamp away from both edges
  ctx.setLineDash([]);
  ctx.font         = `500 ${isMobile ? 11 : 12}px "DM Mono", monospace`;
  ctx.fillStyle    = C.textPrimary;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'bottom';
  const nowLabelX  = Math.max(nowX, pad.left + 18);
  ctx.fillText('now', nowLabelX, pad.top - 4);

  ctx.restore();
}

// ─── Header update ────────────────────────────────────────────────────────────

function updateHeader() {
  const now      = new Date();
  const winStart = new Date(now.getTime() - 12 * 60 * 60 * 1000);
  const winEnd   = new Date(now.getTime() + 12 * 60 * 60 * 1000);

  chartDateLabel.textContent =
    winStart.toDateString() === winEnd.toDateString()
      ? fmtDateFull(now)
      : `${fmtDateShort(winStart)} – ${fmtDateShort(winEnd)}`;
}

// ─── Show chart ───────────────────────────────────────────────────────────────

function showChart() {
  updateHeader();
  hideChartStatus();
  chartCard.classList.remove('hidden');
  drawChart();
}

// ─── Station selection event ──────────────────────────────────────────────────

document.addEventListener('stationSelected', async (e) => {
  stationInfo = e.detail;
  chartSection.classList.remove('hidden');
  setChartStatus('loading', 'Loading tide data', `Fetching predictions for ${stationInfo.name}…`);
  try {
    await loadTideData(stationInfo);
    showChart();
  } catch (err) {
    console.error('[TideWatch] Tide data error:', err);
    showChartError(err.message);
  }
});

// ─── Resize handler ───────────────────────────────────────────────────────────

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!chartCard.classList.contains('hidden')) { updateHeader(); drawChart(); }
  }, 120);
});
