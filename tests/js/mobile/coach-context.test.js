import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../../web/js/data/db.js';
import { upsertDailyMetric, putProfile } from '../../../web/js/data/queries.js';
import { buildCoachContext } from '../../../web/js/mobile/coach-context.js';

let db;
let n = 0;

beforeEach(async () => {
  db = await openDb(`coach-ctx-${++n}`);
});

function dayKey(offset) {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('buildCoachContext', () => {
  it('returns an empty-but-valid shape with no data', async () => {
    const ctx = await buildCoachContext(db);
    expect(ctx.days_of_data).toBe(0);
    expect(ctx.daily_metrics).toEqual([]);
    expect(ctx.recent_workouts).toEqual([]);
    expect(ctx.profile).toBe(null);
    expect(typeof ctx.today).toBe('string');
  });

  it('includes profile + daily metrics newest-first, curated and rounded', async () => {
    await putProfile(db, { age: 31, sex: 'M', weight_kg: 76.34, height_cm: 181 });
    await upsertDailyMetric(db, { date: dayKey(2), recovery_score: 60, rmssd_ms: 51.27, resting_hr: 50 });
    await upsertDailyMetric(db, { date: dayKey(0), recovery_score: 74, rmssd_ms: 58.88, resting_hr: 49, secret_field: 'leak' });

    const ctx = await buildCoachContext(db);
    expect(ctx.days_of_data).toBe(2);
    // newest first
    expect(ctx.daily_metrics[0].date).toBe(dayKey(0));
    expect(ctx.daily_metrics[0].recovery_score).toBe(74);
    // rounded to 1 dp
    expect(ctx.daily_metrics[0].rmssd_ms).toBe(58.9);
    // only whitelisted fields survive
    expect(ctx.daily_metrics[0].secret_field).toBeUndefined();
    // profile rounded + trimmed
    expect(ctx.profile.weight_kg).toBe(76.3);
    expect(ctx.profile.age).toBe(31);
  });

  it('caps daily metrics at ~90 days', async () => {
    for (let i = 0; i < 120; i++) {
      await upsertDailyMetric(db, { date: dayKey(i), recovery_score: 50 + (i % 40) });
    }
    const ctx = await buildCoachContext(db);
    expect(ctx.daily_metrics.length).toBeLessThanOrEqual(90);
  });
});
