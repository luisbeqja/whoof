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

  // Foreground/background handling.
  //
  // A WebView app can't keep BLE running while the phone is asleep — Android
  // suspends the web layer and notifications stop. Worse, if the GATT link
  // *stays* connected while we're suspended, the strap streams live data to a
  // host that isn't listening (lost) instead of recording to its own flash.
  //
  // So: when we go to the background, RELEASE the strap (after a short grace,
  // so quick app-switches don't churn) — that puts the strap into its own
  // continuous flash-recording mode. When we come back, RECONNECT, which runs
  // the historical backfill and pulls everything recorded while we were away
  // (e.g. overnight sleep). autoConnect() self-guards against double-connects.
  let bgReleaseTimer = null;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (bgReleaseTimer) { clearTimeout(bgReleaseTimer); bgReleaseTimer = null; }
      strap.autoConnect();
    } else {
      if (bgReleaseTimer) clearTimeout(bgReleaseTimer);
      bgReleaseTimer = setTimeout(() => {
        bgReleaseTimer = null;
        if (strap.isConnected()) strap.disconnect().catch(() => {});
      }, 20000);
    }
  });
}

boot();
