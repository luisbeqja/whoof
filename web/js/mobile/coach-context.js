// Builds the "all my WHOOP data" snapshot the Claude coach reasons over.
//
// The coach is stateless and lives at the edge (functions/api/coach.js) — it
// has no access to the user's IndexedDB. So we assemble a compact-but-complete
// snapshot here and POST it with each chat. "Complete" = profile + up to ~90
// days of daily metrics + recent workouts + journal + last night's sleep
// stages + all-time records. We deliberately exclude the raw per-second
// `samples` store (megabytes) — the daily rollups already summarise it.
//
// Curated + rounded to keep the payload to a few thousand tokens so it caches
// cheaply on the model side and stays well under the request size guard.

import { recentDailyMetrics, getProfile, recentJournalEntries, personalRecords, sleepStagesForDate } from '../data/queries.js';
import { localDateKey } from '../util/time.js';

const DAYS = 90;
const MAX_WORKOUTS = 20;

// Daily-metric fields worth sending (drops internal/duplicate/empty noise).
const DM_FIELDS = [
  'date', 'recovery_score', 'rmssd_ms', 'hrv_baseline_ms', 'resting_hr',
  'strain_score', 'zone_weighted_strain_score', 'sleep_minutes', 'sleep_performance_pct',
  'sleep_need_minutes', 'sleep_debt_minutes', 'sleep_consistency_pct',
  'deep_sleep_minutes', 'rem_sleep_minutes', 'light_sleep_minutes', 'wake_sleep_minutes',
  'respiratory_rate', 'avg_spo2', 'skin_temp_deviation_c', 'calories',
  'energy_kcal_active', 'stress_avg', 'vo2max', 'whoop_age', 'bedtime_local', 'wake_local',
];

function round(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return v;
  return Math.round(v * 10) / 10;
}

function pick(row, fields) {
  const out = {};
  for (const k of fields) {
    const v = row[k];
    if (v !== null && v !== undefined && v !== '') out[k] = round(v);
  }
  return out;
}

function getAll(db, store) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store);
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

/**
 * Assemble the full coach context. Safe to call with a partially-populated DB —
 * every section degrades to an empty array / null rather than throwing.
 * @param {IDBDatabase} db
 * @returns {Promise<object>}
 */
export async function buildCoachContext(db) {
  const today = localDateKey();

  const [metricsRaw, profile, journal, records, allWorkouts] = await Promise.all([
    recentDailyMetrics(db, DAYS).catch(() => []),
    getProfile(db).catch(() => null),
    recentJournalEntries(db, 30).catch(() => []),
    personalRecords(db).catch(() => ({})),
    getAll(db, 'workouts'),
  ]);

  const daily_metrics = (metricsRaw ?? []).map((m) => pick(m, DM_FIELDS));

  const workouts = (allWorkouts ?? [])
    .slice()
    .sort((a, b) => (a.date > b.date ? -1 : 1))
    .slice(0, MAX_WORKOUTS)
    .map((w) => {
      const out = {};
      for (const [k, v] of Object.entries(w)) {
        if (k === 'id') continue;
        if (v === null || v === undefined || v === '') continue;
        out[k] = round(v);
      }
      return out;
    });

  // Last night's sleep stages, keyed off the most recent day with sleep data.
  let sleep_last_night = [];
  const lastSleepDate = (metricsRaw ?? []).find((m) => m.sleep_minutes)?.date ?? today;
  try {
    const stages = await sleepStagesForDate(db, lastSleepDate);
    sleep_last_night = (stages ?? []).map(({ id, ...rest }) => rest);
  } catch { /* none */ }

  // Trim profile to the fields the coach can use for context.
  let profileOut = null;
  if (profile) {
    profileOut = {};
    for (const k of ['age', 'sex', 'weight_kg', 'height_cm', 'max_hr']) {
      if (profile[k] !== null && profile[k] !== undefined) profileOut[k] = round(profile[k]);
    }
  }

  return {
    today,
    timezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } })(),
    profile: profileOut,
    days_of_data: daily_metrics.length,
    daily_metrics,        // newest first
    recent_workouts: workouts,
    journal,              // [{date, text, tags}]
    sleep_last_night,     // [{stage, start_utc, end_utc, ...}]
    personal_records: records,
  };
}
