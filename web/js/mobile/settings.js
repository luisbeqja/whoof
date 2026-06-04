// Settings overlay — lets the user store their own Anthropic API key (and pick
// a model) so the Coach can call Claude directly, no server needed. The key is
// stored only in this device's localStorage (see coach-client.js).

import { getApiKey, setApiKey, clearApiKey, getModel, setModel, hasApiKey, MODELS } from './coach-client.js';
import { getTheme, setTheme } from './theme.js';

let root = null;
let onChange = () => {};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function mountSettings(container, opts = {}) {
  root = container;
  onChange = opts.onChange || (() => {});
  root.className = 'settings-overlay';
  root.innerHTML = `
    <div class="settings-sheet">
      <div class="settings-head">
        <span>Settings</span>
        <button id="set-close" aria-label="Close">✕</button>
      </div>

      <span class="set-label">Appearance</span>
      <div class="theme-toggle" role="group" aria-label="Appearance">
        <button type="button" class="theme-opt" data-theme="dark">🌙 Dark</button>
        <button type="button" class="theme-opt" data-theme="light">☀️ Light</button>
      </div>

      <label class="set-label" for="set-key">Anthropic API key</label>
      <div class="set-key-row">
        <input id="set-key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false"
               placeholder="sk-ant-…" />
        <button id="set-reveal" type="button" aria-label="Show key">👁</button>
      </div>
      <p class="set-note">Used so the Coach can talk to Claude. Stored only on this device — never uploaded, never in the app itself. Get one at console.anthropic.com.</p>

      <label class="set-label" for="set-model">Model</label>
      <select id="set-model">
        ${MODELS.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('')}
      </select>

      <div class="settings-actions">
        <button id="set-clear" class="btn-ghost">Remove key</button>
        <button id="set-save" class="btn-primary">Save</button>
      </div>
      <div id="set-status" class="set-status"></div>
    </div>
  `;

  const keyInput = root.querySelector('#set-key');
  const modelSel = root.querySelector('#set-model');
  const status = root.querySelector('#set-status');

  // Appearance toggle — applies immediately (live preview) and persists.
  const themeOpts = root.querySelectorAll('.theme-opt');
  themeOpts.forEach((btn) => btn.addEventListener('click', () => {
    setTheme(btn.dataset.theme);
    syncThemeButtons();
  }));

  root.querySelector('#set-reveal').addEventListener('click', () => {
    keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
  });
  root.querySelector('#set-close').addEventListener('click', close);
  root.addEventListener('click', (e) => { if (e.target === root) close(); }); // tap backdrop

  root.querySelector('#set-save').addEventListener('click', () => {
    const v = keyInput.value.trim();
    if (v) setApiKey(v);
    setModel(modelSel.value);
    status.textContent = v ? 'Saved ✓' : 'Model saved (no key set)';
    status.style.color = 'var(--accent)';
    onChange();
    setTimeout(close, 600);
  });

  root.querySelector('#set-clear').addEventListener('click', () => {
    clearApiKey();
    keyInput.value = '';
    status.textContent = 'Key removed';
    status.style.color = 'var(--muted)';
    onChange();
  });
}

function syncThemeButtons() {
  if (!root) return;
  const current = getTheme();
  root.querySelectorAll('.theme-opt').forEach((btn) =>
    btn.classList.toggle('active', btn.dataset.theme === current));
}

export function openSettings() {
  if (!root) return;
  syncThemeButtons();
  // Show the stored key masked-but-present so the user knows one is set,
  // without us re-displaying the secret in full unless they reveal it.
  const k = getApiKey();
  root.querySelector('#set-key').value = k;
  root.querySelector('#set-key').type = 'password';
  root.querySelector('#set-model').value = getModel();
  root.querySelector('#set-status').textContent = hasApiKey() ? 'A key is saved on this device.' : '';
  root.querySelector('#set-status').style.color = 'var(--muted)';
  root.classList.add('open');
}

function close() { root?.classList.remove('open'); }
