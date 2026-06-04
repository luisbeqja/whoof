// WHOOP strap engine for the minimal mobile app.
//
// This is the DOM-free core of the (much larger) dashboard's app-mvp.js: it
// wires a WhoopClient to IndexedDB — live samples + RR, historical backfill,
// battery / wrist / clock events — and recomputes daily rollups when a backfill
// lands. The UI subscribes to a tiny event bus instead of the engine touching
// the DOM, so the Home screen and the engine stay decoupled.
//
// The same code runs in three places unchanged: desktop Chrome (real
// navigator.bluetooth), Bluefy on iPhone, and the Capacitor native shell on
// Android/iOS (navigator.bluetooth synthesised by ble/capacitor-bridge.js).

import { WhoopClient } from '../ble/client.js';
import { openDb } from '../data/db.js';
import { insertSamplesBatch, startSession, endSession, logEvent, getProfile } from '../data/queries.js';
import { isoUtcNow } from '../util/time.js';
import { recomputeRecent } from '../metrics/rollup.js';

// ---- tiny event bus --------------------------------------------------------
const listeners = new Map();
export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt)?.delete(fn);
}
function emit(evt, payload) {
  const set = listeners.get(evt);
  if (set) for (const fn of set) { try { fn(payload); } catch (e) { console.error('[strap]', e); } }
}

// ---- shared state ----------------------------------------------------------
export const state = {
  status: 'disconnected',   // disconnected | connecting | connected | reconnecting
  hr: null,
  battery: null,
  worn: null,
  charging: null,
  clockSynced: null,
  lastError: null,
};

let db = null;
let client = null;
let currentSession = null;
let sampleCount = 0;
let buffer = [];

export async function getDb() {
  if (!db) db = await openDb();
  return db;
}

// ---- sample buffering ------------------------------------------------------
async function flush() {
  if (!db || buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  try {
    await insertSamplesBatch(db, batch);
  } catch (err) {
    console.error('[strap] flush failed', err);
    buffer.unshift(...batch);
  }
}
setInterval(flush, 1000);

function emptySample(ts, hr, rr) {
  return {
    ts_utc: ts, session_id: currentSession, sequence: null,
    heart_rate_bpm: hr, rr_interval_ms: rr,
    spo2_pct: null, skin_temp_c: null,
    accel_x: null, accel_y: null, accel_z: null,
    motion: null, ppg_amp: null, ambient_light: null, ppg_quality: null,
    crc_ok: 1,
  };
}

function setStatus(s) {
  state.status = s;
  console.log('[strap] state →', s);
  emit('status', s);
}

// ---- friendly BLE errors (ported from app-mvp) -----------------------------
function friendlyBleError(err) {
  const msg = err?.message ?? String(err);
  const name = err?.name ?? '';
  if (/cancel/i.test(msg)) return null;
  if (/no devices? (found|chosen)/i.test(msg)) {
    return 'No WHOOP found nearby. Take the strap off the charger, tap it hard 2–3 times to wake it (LEDs blink), then tap Connect again within ~5 seconds.';
  }
  if (/unsupported device/i.test(msg)) {
    return "That device isn't advertising the WHOOP service. Take it off the charger, tap to wake it, and force-quit the official WHOOP app on any nearby phone — a strap talks to one host at a time.";
  }
  if (name === 'SecurityError' || /secure context/i.test(msg)) {
    return 'Bluetooth needs a secure context (HTTPS). Open the app from getwhoof.pages.dev or the installed app.';
  }
  if (name === 'NotSupportedError' || /not supported/i.test(msg)) {
    return 'Bluetooth isn\'t available here. Use the installed Android/iOS app, desktop Chrome, or Bluefy on iPhone.';
  }
  if (/gatt/i.test(msg)) return `Bluetooth dropped (${msg}). Move closer to the strap and tap Connect again.`;
  return `Bluetooth: ${msg}`;
}

function fail(err) {
  const friendly = friendlyBleError(err);
  if (friendly !== null) {
    state.lastError = friendly;
    emit('error', friendly);
  }
}

// ---- connect / disconnect --------------------------------------------------
async function wireAndConnect(deviceToUse = null, { silent = false } = {}) {
  state.lastError = null;
  emit('error', null);

  if (!navigator.bluetooth) {
    if (!silent) fail(new Error('not supported'));
    return;
  }
  if (!db) db = await openDb();
  client = new WhoopClient();

  client.on('state', (s) => setStatus(s));
  client.on('family', (f) => console.log('[strap] family:', f && (f.family ?? JSON.stringify(f)), f && f.name ? `(${f.name})` : ''));
  client.on('log', (t) => console.log('[strap] fw:', t));

  client.on('sample', (pkt) => {
    const hr = pkt.heartRateBpm;
    const rrList = Array.isArray(pkt.rrIntervalsMs) ? pkt.rrIntervalsMs : [];
    if (hr != null) { state.hr = Math.round(hr); emit('hr', state.hr); }
    sampleCount += 1;
    const ts = isoUtcNow();
    if (!rrList.length) buffer.push(emptySample(ts, hr, null));
    else for (const rr of rrList) buffer.push(emptySample(ts, hr, rr));
  });

  client.on('historicalSample', (rec) => {
    if (!db) return;
    const ts = rec.isoUtc;
    if (rec.rrIntervalsMs?.length) {
      for (const rr of rec.rrIntervalsMs) buffer.push(emptySample(ts, rec.heartRateBpm, rr));
    } else {
      buffer.push(emptySample(ts, rec.heartRateBpm, null));
    }
  });

  client.on('historyStart', () => emit('sync', 'Backfilling from strap…'));
  client.on('historyProgress', ({ samples }) => emit('sync', `Backfilled ${samples.toLocaleString()} samples…`));
  client.on('historyComplete', async ({ samples }) => {
    emit('sync', `Backfill done: ${samples.toLocaleString()} samples — computing…`);
    await flush();
    if (db) await logEvent(db, 'backfill', `samples=${samples}`).catch(() => {});
    try {
      const profile = (await getProfile(db)) ?? {};
      await recomputeRecent(db, 14, profile.age ? { ageOverride: profile.age } : {});
      emit('sync', null);
      emit('data-changed');
    } catch (err) {
      emit('sync', `Saved, but compute failed: ${err.message ?? err}`);
    }
  });
  client.on('historyError', (err) => emit('sync', 'Backfill error: ' + (err.message ?? err)));

  client.on('battery', async (pct) => {
    state.battery = Math.round(pct);
    emit('battery', state.battery);
    if (db) await logEvent(db, 'battery', `${state.battery}%`).catch(() => {});
  });

  client.on('hello', (hello) => {
    if (hello.isWorn !== undefined) state.worn = hello.isWorn;
    if (hello.charging !== undefined) state.charging = hello.charging;
    emit('strap', { worn: state.worn, charging: state.charging });
    if (db) logEvent(db, 'hello', JSON.stringify(hello)).catch(() => {});
  });

  client.on('clock', () => { state.clockSynced = true; emit('clock', true); });

  client.on('event', async (evt) => {
    if (db) await logEvent(db, (evt.name || 'event').toLowerCase(), evt.semantic ?? '').catch(() => {});
    if (evt.semantic === 'wristOn') { state.worn = true; emit('strap', { worn: true, charging: state.charging }); }
    if (evt.semantic === 'wristOff') { state.worn = false; emit('strap', { worn: false, charging: state.charging }); }
    if (evt.semantic === 'chargingOn') { state.charging = true; emit('strap', { worn: state.worn, charging: true }); }
    if (evt.semantic === 'chargingOff') { state.charging = false; emit('strap', { worn: state.worn, charging: false }); }
  });

  client.on('error', (err) => { console.error('[strap] ble', err); fail(err); });

  try {
    console.log('[strap] connecting…', deviceToUse ? '(paired device)' : '(picker)');
    if (deviceToUse) await client.connectToDevice(deviceToUse);
    else await client.requestAndConnect();
    console.log('[strap] gatt up — device:', client.device?.name ?? client.device?.id ?? '?');
    currentSession = await startSession(db, 'mobile-session');
    await logEvent(db, 'connect', client.device?.id ?? 'unknown').catch(() => {});
  } catch (err) {
    console.error('[strap] connect failed:', err && err.name, '-', (err && err.message) || err);
    setStatus('disconnected');
    // Auto-reconnect on launch is best-effort — don't show a scary error banner
    // just because the strap happened not to be in range.
    if (!silent) fail(err);
  }
}

export async function connect() {
  await wireAndConnect();
}

export async function disconnect() {
  if (!client) return;
  try { await client.disconnect(); } catch (err) { console.error(err); }
  await flush();
  if (currentSession && db) {
    await endSession(db, currentSession, sampleCount).catch(() => {});
    await logEvent(db, 'disconnect', `samples=${sampleCount}`).catch(() => {});
  }
}

export async function syncNow() {
  if (!client?.connected) { emit('sync', 'Not connected to strap'); return; }
  try { await client.downloadHistory(); }
  catch (err) { emit('sync', 'Sync failed: ' + (err.message ?? err)); }
}

export function isConnected() {
  return !!client?.connected;
}

// Reconnect silently to an already-paired strap on boot (native shell / Chrome
// that remembers the device). No-op where getDevices isn't available.
export async function autoConnect() {
  // Safe to call on every app resume — skip if a connection is already up or
  // in progress so we never stack parallel connect attempts.
  if (state.status !== 'disconnected') return;
  if (!navigator.bluetooth?.getDevices) return;
  try {
    const devices = await navigator.bluetooth.getDevices();
    const whoop = devices.find((d) => d.name && d.name.toUpperCase().includes('WHOOP')) || devices[0];
    if (whoop) {
      console.log('[strap] auto-reconnecting to', whoop.name ?? whoop.id);
      await wireAndConnect(whoop, { silent: true });
    }
  } catch (err) {
    console.warn('[strap] auto-connect failed', err);
  }
}
