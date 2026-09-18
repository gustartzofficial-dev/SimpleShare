// Runs before app.js. The legacy Steam theme used to rebuild/reparent the room
// DOM. Keep its visual preference, but prevent that old layout shell from
// mounting; ui-overhaul.js reapplies Steam as a token-only theme afterwards.
const OVERHAUL_THEME_KEY = 'simpleshare-theme-overhaul';

try {
  const legacyTheme = localStorage.getItem('simpleshare-theme');
  if (legacyTheme === 'steam') {
    localStorage.setItem(OVERHAUL_THEME_KEY, 'steam');
    localStorage.setItem('simpleshare-theme', 'default');
  }
} catch {}
