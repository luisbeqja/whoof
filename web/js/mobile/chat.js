// Coach chat screen.
//
// Talks to functions/api/coach.js (Claude). On first open it snapshots the
// user's full WHOOP history once (so the model-side prompt cache hits across
// turns) and sends it with every message alongside the running history.
// Rebuilds the snapshot only when a strap sync brings in new data.

import * as strap from './strap.js';
import { buildCoachContext } from './coach-context.js';
import { hasApiKey, askCoachDirect } from './coach-client.js';
import { openSettings } from './settings.js';

let root = null;
let logEl = null;
let apiBase = '';
let history = [];          // [{role, content}]
let context = null;        // cached WHOOP snapshot for this session
let contextStale = true;
let greeted = false;
let busy = false;

const SUGGESTIONS = [
  'How am I recovering this week?',
  'Should I train hard today?',
  'What is hurting my sleep?',
  "Explain today's strain.",
];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function bubble(role, text) {
  const el = document.createElement('div');
  el.className = `bubble ${role === 'user' ? 'bubble-user' : 'bubble-ai'}`;
  el.textContent = text;
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
  return el;
}

function renderSuggestions() {
  const wrap = document.createElement('div');
  wrap.className = 'suggestions';
  wrap.innerHTML = SUGGESTIONS.map((s) => `<button class="chip">${esc(s)}</button>`).join('');
  wrap.querySelectorAll('.chip').forEach((b) =>
    b.addEventListener('click', () => { send(b.textContent); wrap.remove(); }));
  logEl.appendChild(wrap);
  logEl.scrollTop = logEl.scrollHeight;
}

async function ensureContext() {
  if (context && !contextStale) return context;
  try {
    const db = await strap.getDb();
    context = await buildCoachContext(db);
    contextStale = false;
  } catch (err) {
    console.warn('[chat] context build failed', err);
    context = context || {};
  }
  return context;
}

async function send(text) {
  if (busy) return;
  const msg = (text || '').trim();
  if (!msg) return;
  busy = true;
  const sendBtn = root.querySelector('#chat-send');
  if (sendBtn) sendBtn.disabled = true;

  bubble('user', msg);
  history.push({ role: 'user', content: msg });
  const thinking = bubble('ai', '…');
  thinking.classList.add('thinking');

  try {
    const ctx = await ensureContext();
    const priorTurns = history.slice(0, -1);
    let reply;
    if (hasApiKey()) {
      // Direct to Claude with the user's own key (no server). askCoachDirect
      // throws with a friendly message on failure.
      reply = await askCoachDirect({ message: msg, history: priorTurns, context: ctx });
      history.push({ role: 'assistant', content: reply });
    } else {
      // Fall back to the optional server endpoint (if deployed with a key).
      const res = await fetch(`${apiBase}/api/coach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, history: priorTurns, context: ctx }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.reply) {
        reply = data.reply;
        history.push({ role: 'assistant', content: data.reply });
      } else if (res.status === 503 || res.status === 404) {
        reply = 'To chat, add your Anthropic API key in Settings — tap ⚙ at the top right.';
      } else {
        reply = `Sorry — I couldn't answer that (${esc(data.message || res.status)}).`;
      }
    }
    thinking.textContent = reply;
    thinking.classList.remove('thinking');
  } catch (e) {
    thinking.textContent = (e && e.message) ? e.message : 'Something went wrong reaching the coach.';
    thinking.classList.remove('thinking');
  } finally {
    busy = false;
    if (sendBtn) sendBtn.disabled = false;
  }
}

async function greet() {
  if (greeted) return;
  greeted = true;
  // Tailor the greeting to whether there's data yet.
  let line = 'Hey! I can see your full WHOOP history. Ask me anything about your recovery, sleep, strain or trends.';
  try {
    const ctx = await ensureContext();
    if (!ctx.days_of_data) {
      line = 'Hey! Connect your WHOOP and sync a bit of data, then I can talk you through your recovery, sleep and training.';
    } else {
      const t = ctx.daily_metrics?.[0];
      if (t && t.recovery_score != null) {
        line = `Hey! Your latest recovery is ${Math.round(t.recovery_score)}%. Ask me anything about your recovery, sleep, strain or trends.`;
      }
    }
  } catch { /* keep default */ }
  bubble('ai', line);
  if (!hasApiKey()) {
    const tip = bubble('ai', 'First, tap ⚙ (top right) and paste your Anthropic API key — then I can chat about your data.');
    tip.style.cursor = 'pointer';
    tip.addEventListener('click', () => openSettings());
  }
  renderSuggestions();
}

export function mountChat(container, opts = {}) {
  root = container;
  apiBase = opts.apiBase || '';
  root.innerHTML = `
    <header class="chat-head">
      <button class="chat-back" id="chat-back" aria-label="Back">←</button>
      <div class="chat-title"><span class="coach-dot">✦</span> Coach</div>
      <button class="chat-gear" id="chat-gear" aria-label="Settings">⚙</button>
    </header>
    <div class="chat-log" id="chat-log"></div>
    <form class="chat-bar" id="chat-form">
      <input id="chat-input" type="text" autocomplete="off" placeholder="Ask about your data…" />
      <button id="chat-send" type="submit" aria-label="Send">↑</button>
    </form>
  `;
  logEl = root.querySelector('#chat-log');
  root.querySelector('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = root.querySelector('#chat-input');
    const v = input.value;
    input.value = '';
    send(v);
  });
  root.querySelector('#chat-back').addEventListener('click', () => (opts.onBack || (() => {}))());
  root.querySelector('#chat-gear').addEventListener('click', () => openSettings());

  // a strap sync invalidates the cached snapshot
  strap.on('data-changed', () => { contextStale = true; });
}

// Called when the chat screen becomes visible.
export function openChat() {
  greet();
  setTimeout(() => root?.querySelector('#chat-input')?.focus(), 50);
}
