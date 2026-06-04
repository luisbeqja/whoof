// Light / dark appearance.
//
// The whole UI is themed through CSS custom properties (see mobile.css); this
// module just flips `data-theme` on <html> and remembers the choice on this
// device. Dark is the default. The same flag is also applied synchronously by a
// tiny inline script in index.html so there's no flash of the wrong theme on
// load — keep the storage key and values in sync with it.

const THEME_STORAGE = 'whoof.theme';

// Status-bar / browser-chrome colour per theme (mirrors --bg in mobile.css).
const THEME_COLOR = { dark: '#0a0b0d', light: '#f6f7f4' };

export function getTheme() {
  try {
    return localStorage.getItem(THEME_STORAGE) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

// In the native Android/iOS shell the system bars are transparent (edge-to-edge,
// see MainActivity), so the app background shows through them — but the status-bar
// icons still need to flip per theme or they'd be invisible (white icons on a
// light background). 'DARK' = light icons (our dark theme); 'LIGHT' = dark icons
// (light theme). No-op on the web / if the plugin isn't present.
function syncNativeStatusBar(t) {
  try {
    const cap = window.Capacitor;
    if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return;
    const StatusBar = cap.Plugins && cap.Plugins.StatusBar;
    if (!StatusBar) return;
    StatusBar.setStyle({ style: t === 'light' ? 'LIGHT' : 'DARK' });
  } catch { /* ignore */ }
}

export function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.setAttribute('content', THEME_COLOR[t]);
  const colorScheme = document.querySelector('meta[name="color-scheme"]');
  if (colorScheme) colorScheme.setAttribute('content', t);
  syncNativeStatusBar(t);
}

export function setTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  try { localStorage.setItem(THEME_STORAGE, t); } catch { /* ignore */ }
  applyTheme(t);
}
