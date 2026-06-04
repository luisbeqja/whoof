// Home screen — the glanceable "most important info, straight away" view.
//
// Reads the daily rollups out of IndexedDB and renders a hero Recovery ring,
// Strain + Sleep rings, a one-line training recommendation, and a grid of key
// stat tiles. Subscribes to the strap engine for the live connection pill and
// realtime heart rate. Styled after the reference design system (dark canvas,
// lime accent, soft rounded cards).

import * as strap from './strap.js';
import { recentDailyMetrics } from '../data/queries.js';
import { dailyPlan } from '../metrics/plan.js';
import { localDateKey } from '../util/time.js';

const COLORS = {
  recHigh: '#c8ff3d',   // lime — strong recovery
  recMid: '#ffc44d',
  recLow: '#ff5a6a',
  strain: '#46d8ff',
  sleep: '#7e8bff',
  track: 'rgba(255,255,255,0.07)',
};

function recoveryColor(v) {
  if (v == null) return COLORS.track;
  if (v >= 67) return COLORS.recHigh;
  if (v >= 34) return COLORS.recMid;
  return COLORS.recLow;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDuration(min) {
  if (min == null) return '—';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function relDate(key) {
  const today = localDateKey();
  if (key === today) return 'Today';
  const d = new Date(key + 'T00:00:00');
  const yest = new Date(); yest.setDate(yest.getDate() - 1);
  if (key === localDateKey(yest)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

// 270° gauge arc. value/max → filled fraction. Returns an <svg> string.
function ring({ value, max, color, size = 200, stroke = 16, label, sub }) {
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;
  const arcFrac = 0.75;                 // 270° sweep
  const trackLen = circ * arcFrac;
  const frac = value == null || !max ? 0 : Math.max(0, Math.min(1, value / max));
  const dash = `${trackLen * frac} ${circ}`;
  const rot = 135;                       // start bottom-left, sweep clockwise
  const disp = value == null ? '—' : (Number.isInteger(value) ? value : Math.round(value));
  return `
  <div class="ring" style="width:${size}px;height:${size}px;">
    <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${COLORS.track}"
        stroke-width="${stroke}" stroke-linecap="round"
        stroke-dasharray="${trackLen} ${circ}" transform="rotate(${rot} ${cx} ${cy})"/>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}"
        stroke-width="${stroke}" stroke-linecap="round"
        stroke-dasharray="${dash}" transform="rotate(${rot} ${cx} ${cy})"
        style="transition:stroke-dasharray .6s ease;"/>
    </svg>
    <div class="ring-center">
      <div class="ring-value" style="color:${color}">${disp}</div>
      <div class="ring-label">${esc(label)}</div>
      ${sub ? `<div class="ring-sub">${esc(sub)}</div>` : ''}
    </div>
  </div>`;
}

function tile(label, value, unit, accent) {
  return `
  <div class="tile">
    <div class="tile-label">${esc(label)}</div>
    <div class="tile-value" ${accent ? `style="color:${accent}"` : ''}>${esc(value)}<span class="tile-unit">${esc(unit || '')}</span></div>
  </div>`;
}

let root = null;
let onOpenChat = () => {};

// Pick the most recent day that actually has computed metrics.
function latestUsable(metrics) {
  for (const m of metrics) {
    const hasRec = m.recovery_score != null && m.rmssd_ms != null;
    if (hasRec || m.strain_score != null || m.sleep_minutes != null) return m;
  }
  return metrics[0] ?? null;
}

async function render() {
  if (!root) return;
  const db = await strap.getDb();
  let metrics = [];
  try { metrics = await recentDailyMetrics(db, 14); } catch { metrics = []; }
  const today = latestUsable(metrics);

  const connected = strap.state.status === 'connected';

  if (!today) {
    root.innerHTML = `
      <header class="home-head">
        <div><div class="hello">${greeting()}</div><div class="subtitle">Let's see your day</div></div>
        ${headActions()}
      </header>
      <div class="empty-hero">
        <div class="empty-ring">${ring({ value: null, max: 100, color: COLORS.track, size: 220, label: 'Recovery' })}</div>
        <h2>No data yet</h2>
        <p>Connect your WHOOP strap to pull your recovery, strain and sleep — then ask the coach anything about it.</p>
        <button class="btn-primary" id="home-connect">Connect WHOOP</button>
        <a class="dash-link" href="/dashboard.html">Open the full dashboard →</a>
      </div>`;
    wirePill();
    return;
  }

  const recValid = today.recovery_score != null && today.rmssd_ms != null;
  const rec = recValid ? today.recovery_score : null;
  const recCol = recoveryColor(rec);

  // training recommendation
  const strains = metrics.map((m) => m.strain_score).filter((v) => v != null);
  const avgStrain7d = strains.length ? strains.reduce((a, b) => a + b, 0) / strains.length : null;
  const recs = metrics.map((m) => m.recovery_score).filter((v) => v != null);
  const lowStreak = recs.length >= 3 && recs.slice(0, 3).every((r) => r < 33);
  let plan = null;
  try {
    plan = dailyPlan({
      recoveryScore: rec,
      sleepPerformancePct: today.sleep_minutes ? today.sleep_performance_pct : null,
      sleepDebtMinutes: today.sleep_minutes ? today.sleep_debt_minutes : null,
      avgStrain7d,
      lowStreakDays: lowStreak,
    });
  } catch { /* ignore */ }

  const hrvSub = [
    today.rmssd_ms != null ? `HRV ${Math.round(today.rmssd_ms)}ms` : null,
    today.resting_hr != null ? `RHR ${Math.round(today.resting_hr)}` : null,
  ].filter(Boolean).join(' · ');

  root.innerHTML = `
    <header class="home-head">
      <div>
        <div class="hello">${greeting()}</div>
        <div class="subtitle">${esc(relDate(today.date))}</div>
      </div>
      ${headActions()}
    </header>

    <section class="hero-card">
      ${ring({ value: rec, max: 100, color: recCol, size: 230, stroke: 18, label: 'Recovery', sub: rec == null ? 'wear overnight' : (hrvSub || null) })}
      ${plan ? `<div class="plan" style="--plan:${plan.color}">
          <div class="plan-label">${esc(plan.label)}</div>
          <div class="plan-target">Target strain ${plan.strainRange[0]}–${plan.strainRange[1]}</div>
        </div>` : ''}
    </section>

    <section class="ring-pair">
      <div class="mini-card">
        ${ring({ value: today.strain_score, max: 21, color: COLORS.strain, size: 132, stroke: 12, label: 'Strain' })}
      </div>
      <div class="mini-card">
        ${ring({ value: today.sleep_performance_pct, max: 100, color: COLORS.sleep, size: 132, stroke: 12, label: 'Sleep',
                 sub: today.sleep_minutes ? fmtDuration(today.sleep_minutes) : null })}
      </div>
    </section>

    <section class="tiles">
      ${tile('Heart rate', connected && strap.state.hr != null ? strap.state.hr : (today.resting_hr != null ? Math.round(today.resting_hr) : '—'),
              connected && strap.state.hr != null ? 'bpm · live' : 'bpm rest', connected && strap.state.hr != null ? COLORS.recLow : null)}
      ${tile('HRV', today.rmssd_ms != null ? Math.round(today.rmssd_ms) : '—', 'ms')}
      ${tile('Sleep', today.sleep_minutes != null ? fmtDuration(today.sleep_minutes) : '—', '')}
      ${tile('Calories', today.calories != null ? Math.round(today.calories).toLocaleString() : '—', 'kcal')}
      ${tile('Respiratory', today.respiratory_rate != null ? today.respiratory_rate.toFixed(1) : '—', 'rpm')}
      ${tile('Blood O₂', today.avg_spo2 != null ? Math.round(today.avg_spo2) : '—', '%')}
    </section>

    <button class="coach-cta" id="home-coach">
      <span class="coach-cta-icon">✦</span>
      <span><strong>Ask your coach</strong><br><span class="coach-cta-sub">Anything about your recovery, sleep or training</span></span>
      <span class="coach-cta-arrow">→</span>
    </button>

    <a class="dash-link" href="/dashboard.html">Open the full dashboard →</a>
  `;

  wirePill();
  root.querySelector('#home-coach')?.addEventListener('click', () => onOpenChat());
}

const SYNC_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';

// Pill + (when connected) a "Sync now" button to re-pull buffered data from the
// strap's flash on demand. Wrapped in one container so updateLive() can swap
// the whole thing as the connection state changes.
function actionsInner() {
  const sync = strap.state.status === 'connected'
    ? `<button class="sync-btn" id="home-sync" aria-label="Sync now" title="Sync now">${SYNC_ICON}</button>`
    : '';
  return connectionPill() + sync;
}
function headActions() {
  return `<div class="head-actions" id="home-actions">${actionsInner()}</div>`;
}

function connectionPill() {
  const s = strap.state;
  if (s.status === 'connected') {
    const bits = [];
    if (s.battery != null) bits.push(`${s.battery}%`);
    if (s.worn === true) bits.push('on wrist');
    else if (s.worn === false) bits.push('off wrist');
    return `<button class="pill pill-on" id="home-pill"><span class="dot"></span>${bits.length ? esc(bits.join(' · ')) : 'Connected'}</button>`;
  }
  if (s.status === 'connecting' || s.status === 'reconnecting') {
    return `<button class="pill pill-busy" id="home-pill"><span class="dot"></span>${s.status}…</button>`;
  }
  return `<button class="pill pill-off" id="home-pill">Connect strap</button>`;
}

function wirePill() {
  const handler = async () => {
    if (strap.state.status === 'connected') await strap.disconnect();
    else await strap.connect();
  };
  root.querySelector('#home-pill')?.addEventListener('click', handler);
  root.querySelector('#home-connect')?.addEventListener('click', () => strap.connect());
  root.querySelector('#home-sync')?.addEventListener('click', () => strap.syncNow());
}

// Update just the live bits (HR, pill) without a full re-render, to keep the
// rings from flickering while streaming.
function updateLive() {
  if (!root) return;
  const actions = root.querySelector('#home-actions');
  if (actions) {
    // Re-render pill + sync button so the sync button appears/disappears with
    // the connection state.
    actions.innerHTML = actionsInner();
    wirePill();
  }
  // live HR tile (first tile) — only when connected & streaming
  if (strap.state.status === 'connected' && strap.state.hr != null) {
    const tileValue = root.querySelector('.tiles .tile:first-child .tile-value');
    if (tileValue) {
      tileValue.style.color = COLORS.recLow;
      tileValue.innerHTML = `${strap.state.hr}<span class="tile-unit">bpm · live</span>`;
    }
  }
}

export function mountHome(container, opts = {}) {
  root = container;
  onOpenChat = opts.onOpenChat || (() => {});
  render();
  // re-render on new data; light live updates on streaming/connection events
  strap.on('data-changed', () => render());
  strap.on('status', () => updateLive());
  strap.on('battery', () => updateLive());
  strap.on('strap', () => updateLive());
  strap.on('hr', () => updateLive());
  const errBanner = () => {
    const existing = root.querySelector('.err-banner');
    if (strap.state.lastError) {
      if (existing) { existing.textContent = strap.state.lastError; return; }
      const b = document.createElement('div');
      b.className = 'err-banner';
      b.textContent = strap.state.lastError;
      root.prepend(b);
    } else if (existing) existing.remove();
  };
  strap.on('error', errBanner);
  strap.on('sync', (msg) => {
    let el = root.querySelector('.sync-banner');
    if (msg) {
      if (!el) { el = document.createElement('div'); el.className = 'sync-banner'; root.prepend(el); }
      el.textContent = msg;
    } else if (el) el.remove();
  });
}

export function refreshHome() { render(); }
