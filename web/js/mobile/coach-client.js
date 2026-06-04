// Direct Claude client for the Coach — no server required.
//
// When the user stores their own Anthropic API key in Settings, the app calls
// the Anthropic Messages API directly (from the WebView) with that key. The key
// is the user's own and lives only in this device's localStorage; it is never
// bundled in the app and never sent anywhere except api.anthropic.com.
//
// Native (Capacitor) requests go through native HTTP (CapacitorHttp is enabled
// in capacitor.config.json), which sidesteps browser CORS. On the plain web we
// also send `anthropic-dangerous-direct-browser-access` so the call is allowed.

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const KEY_STORAGE = 'whoof.coach.apiKey';
const MODEL_STORAGE = 'whoof.coach.model';
const DEFAULT_MODEL = 'claude-opus-4-8';

export const MODELS = [
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8 — best quality' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 — faster & cheaper' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 — cheapest' },
];

export function getApiKey() {
  try { return (localStorage.getItem(KEY_STORAGE) || '').trim(); } catch { return ''; }
}
export function hasApiKey() { return getApiKey().length > 0; }
export function setApiKey(key) {
  try { localStorage.setItem(KEY_STORAGE, (key || '').trim()); } catch { /* ignore */ }
}
export function clearApiKey() {
  try { localStorage.removeItem(KEY_STORAGE); } catch { /* ignore */ }
}
export function getModel() {
  try { return localStorage.getItem(MODEL_STORAGE) || DEFAULT_MODEL; } catch { return DEFAULT_MODEL; }
}
export function setModel(m) {
  try { localStorage.setItem(MODEL_STORAGE, m || DEFAULT_MODEL); } catch { /* ignore */ }
}

const COACH_INSTRUCTIONS = [
  'You are the in-app coach for "whoof", a WHOOP-style wearable app. You are talking to the owner of the strap about their own body data.',
  '',
  'You have the user\'s complete recent WHOOP history in the JSON block below: their profile, up to ~90 days of daily metrics, recent workouts, journal entries (lifestyle tags), and last night\'s sleep stages. Ground every answer in those actual numbers — cite the values and dates you used.',
  '',
  'Metric guide: recovery_score and sleep_performance_pct are 0–100 (higher is better). strain_score is 0–21 (cardiovascular load). rmssd_ms is HRV (higher generally better). resting_hr in bpm (lower generally better). stress_avg is 0–100 (higher = more stressed). Dates are local YYYY-MM-DD; the most recent day is first in the daily_metrics array.',
  '',
  'Style: warm, direct, and concise — usually 2–5 sentences. Lead with the answer. When the user asks about a trend, compare recent values to their baseline/earlier days and name the numbers. Make practical, specific suggestions.',
  '',
  'Boundaries: this is not medical advice and you are not a clinician — do not diagnose or recommend treatment. If a number looks alarming (e.g. SpO2 < 93%, resting HR far above baseline), suggest they consult a professional rather than interpreting it medically. If the data needed to answer is missing, say so plainly and tell them what to record (e.g. wear the strap overnight).',
].join('\n');

function extractText(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  return blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('').trim();
}

/**
 * Ask Claude directly using the user's stored key. Returns the reply string;
 * throws Error(friendlyMessage) on failure.
 */
export async function askCoachDirect({ message, history = [], context = {} }) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('No API key set. Add one in Settings (⚙).');

  const payload = {
    model: getModel(),
    max_tokens: 1024,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    system: [
      { type: 'text', text: COACH_INSTRUCTIONS },
      {
        type: 'text',
        text: `The user's complete recent WHOOP data (JSON):\n${JSON.stringify(context)}`,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [...history, { role: 'user', content: message }],
  };

  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    throw new Error('Network error reaching Claude. Check your connection.');
  }

  if (!res.ok) {
    if (res.status === 401) throw new Error('Your API key was rejected. Check it in Settings (⚙).');
    if (res.status === 429) throw new Error('Rate limited by Claude. Wait a moment and try again.');
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch { /* ignore */ }
    throw new Error(detail || `Claude returned ${res.status}.`);
  }

  let data;
  try { data = await res.json(); } catch { throw new Error('Could not read Claude\'s response.'); }
  const reply = extractText(data);
  if (!reply) throw new Error('Claude returned an empty response.');
  return reply;
}
