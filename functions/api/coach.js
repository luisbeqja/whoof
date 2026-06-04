// Pages Function backing the AI Coach — powered by Claude (Anthropic).
//
// The browser POSTs the user's question, the prior turns, and a compact-but-
// complete snapshot of ALL their WHOOP data (profile + ~90 days of daily
// metrics + recent workouts, journal, and sleep). We hand that to Claude as a
// cached system block so it can reason over the user's full history — not just
// today's numbers — and answer like a sharp, grounded recovery coach.
//
// Auth: needs an `ANTHROPIC_API_KEY` secret on the deployment
//   (`npx wrangler pages secret put ANTHROPIC_API_KEY`).
// If the key is absent we return 503 with a clear message so the UI can fall
// back to its built-in rule-based tips.
//
// No data is persisted server-side — the snapshot rides in the request and is
// gone when it returns. Calls go straight to the Anthropic Messages API via
// fetch (Cloudflare Pages Functions run on the Workers runtime, which has a
// native fetch; no SDK bundle needed, and we want precise control over the
// prompt-cache breakpoint).

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// claude-opus-4-8 = best quality (user's choice). Swap to 'claude-sonnet-4-6'
// to cut cost ~2x at a small quality tradeoff — it's a one-line change.
const MODEL = 'claude-opus-4-8';

// Adaptive thinking lets Claude decide how hard to think per question; `low`
// effort keeps quick questions snappy while still allowing depth when a
// question genuinely needs it. Bump to 'medium'/'high' for deeper analysis.
const EFFORT = 'low';

const MAX_TOKENS = 1024;
const MAX_MESSAGE = 4000;       // chars per turn
const MAX_HISTORY = 20;         // prior turns kept
const MAX_CONTEXT_BYTES = 400_000; // guard against oversized payloads (413)

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

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// Pull the assistant's text out of the Messages API response, skipping any
// (empty) thinking blocks.
function extractText(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();
}

export async function onRequestPost({ request, env }) {
  const apiKey = env && env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return jsonResponse(
      { error: 'coach_unavailable', message: 'AI coach is not enabled on this deployment (no ANTHROPIC_API_KEY secret set).' },
      503,
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'bad_request', message: 'Expected JSON body.' }, 400);
  }

  const message = typeof body.message === 'string' ? body.message.trim().slice(0, MAX_MESSAGE) : '';
  if (!message) {
    return jsonResponse({ error: 'bad_request', message: 'Empty message.' }, 400);
  }

  // Prior turns: [{ role: 'user'|'assistant', content }]. Kept after the cache
  // breakpoint so the cached data prefix survives across the conversation.
  const history = Array.isArray(body.history)
    ? body.history
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-MAX_HISTORY)
        .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE) }))
    : [];

  // The full WHOOP snapshot. Stringify deterministically-ish; reject if huge.
  let contextJson = '{}';
  if (body.context && typeof body.context === 'object') {
    contextJson = JSON.stringify(body.context);
    if (contextJson.length > MAX_CONTEXT_BYTES) {
      return jsonResponse({ error: 'too_large', message: 'Data snapshot too large.' }, 413);
    }
  }

  const payload = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'adaptive' },
    output_config: { effort: EFFORT },
    system: [
      { type: 'text', text: COACH_INSTRUCTIONS },
      {
        type: 'text',
        // The big, stable block — cached so multi-turn chat is cheap/fast.
        text: `The user's complete recent WHOOP data (JSON):\n${contextJson}`,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [...history, { role: 'user', content: message }],
  };

  let resp;
  try {
    resp = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return jsonResponse({ error: 'network', message: String(err && err.message ? err.message : err) }, 502);
  }

  if (!resp.ok) {
    let detail = '';
    try {
      const errBody = await resp.json();
      detail = errBody?.error?.message || '';
    } catch { /* ignore */ }
    // 401/403 → key problem; surface a clear, actionable message.
    if (resp.status === 401 || resp.status === 403) {
      return jsonResponse({ error: 'auth', message: 'Claude rejected the API key — check the ANTHROPIC_API_KEY secret.' }, 502);
    }
    return jsonResponse({ error: 'inference_failed', message: detail || `Claude returned ${resp.status}.` }, 502);
  }

  let data;
  try {
    data = await resp.json();
  } catch {
    return jsonResponse({ error: 'bad_response', message: 'Could not parse Claude response.' }, 502);
  }

  const reply = extractText(data);
  if (!reply) {
    return jsonResponse({ error: 'empty', message: 'No response generated.' }, 502);
  }
  return jsonResponse({ reply });
}
