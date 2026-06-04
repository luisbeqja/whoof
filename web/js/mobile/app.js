// Mobile app shell — boots the strap engine, mounts the Home and Coach
// screens, and handles the two-tab navigation. This is the entry point for the
// clean minimal app (index.html); the full legacy dashboard lives at
// dashboard.html and is untouched.

import * as strap from './strap.js';
import { mountHome } from './home.js';
import { mountChat, openChat } from './chat.js';
import { mountSettings } from './settings.js';

const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
// In the Capacitor shell the origin is localhost, so the coach must be called
// at the deployed Pages origin. On the web it's same-origin (relative).
const API_BASE = isNative ? 'https://getwhoof.pages.dev' : '';

function show(screen) {
  document.querySelectorAll('.screen').forEach((s) =>
    s.classList.toggle('active', s.id === `screen-${screen}`));
  document.querySelectorAll('.nav-item').forEach((b) =>
    b.classList.toggle('active', b.dataset.screen === screen));
  // Chat is full-screen with its own input bar + back arrow; hide the bottom nav
  // so it can't overlap the message field.
  document.body.classList.toggle('chat-open', screen === 'chat');
  if (screen === 'chat') openChat();
  window.scrollTo({ top: 0 });
}

async function boot() {
  // Install the Web-Bluetooth→native bridge before anything touches
  // navigator.bluetooth (native shell only; no-op on the web).
  if (isNative) {
    try {
      const mod = await import('../ble/capacitor-bridge.js');
      await mod.installCapacitorBleBridge?.();
    } catch (e) {
      console.warn('[app] BLE bridge install failed', e);
    }
  }

  mountHome(document.getElementById('screen-home'), { onOpenChat: () => show('chat') });
  mountChat(document.getElementById('screen-chat'), { apiBase: API_BASE, onBack: () => show('home') });

  // Settings overlay (Anthropic API key + model) — lives at the body level so
  // it floats above both screens.
  const settingsRoot = document.createElement('div');
  document.body.appendChild(settingsRoot);
  mountSettings(settingsRoot);

  document.querySelectorAll('.nav-item').forEach((b) =>
    b.addEventListener('click', () => show(b.dataset.screen)));

  show('home');
  strap.autoConnect();

  // Reconnect when the app returns to the foreground. Android usually keeps the
  // app in memory, so reopening it resumes (rather than relaunches) — without
  // this, a strap that dropped while backgrounded would sit disconnected.
  // autoConnect() self-guards against running while already connected.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') strap.autoConnect();
  });
}

boot();
