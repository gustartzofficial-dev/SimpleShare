// SimpleShare UI shell bridge.
// This intentionally does not touch signalling, PartyTracks, TURN, media,
// budget controls, or the existing compatibility transport hooks.

const OVERHAUL_THEME_KEY = 'simpleshare-theme-overhaul';
const THEME_IDS = new Set([
  'default', 'teamspeak', 'ios', 'xp', 'win98', 'skype',
  'terminal', 'aqua', 'steam', 'youtube', 'holo',
]);
const THEME_NAMES = {
  default: 'Midnight',
  teamspeak: 'TeamSpeak 3',
  ios: 'iOS Glass',
  xp: 'Windows XP',
  win98: 'Windows 98',
  skype: 'Old Skype',
  terminal: 'CRT Terminal',
  aqua: 'Mac OS X Aqua',
  steam: 'Steam Classic',
  youtube: 'YouTube 2012',
  holo: 'Android Holo',
};

const byId = (id) => document.getElementById(id);

function safeGet(key, fallback = null) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}
function safeRemove(key) {
  try { localStorage.removeItem(key); } catch {}
}

function showUiToast(message) {
  const toast = byId('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showUiToast.timer);
  showUiToast.timer = setTimeout(() => toast.classList.remove('show'), 1800);
}

function syncThemePicker(themeId) {
  for (const option of document.querySelectorAll('[data-theme-choice]')) {
    const active = option.dataset.themeChoice === themeId;
    option.classList.toggle('active', active);
    option.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

function applyUiTheme(themeId, { announce = false } = {}) {
  const next = THEME_IDS.has(themeId) ? themeId : 'default';
  document.documentElement.dataset.theme = next;

  // Steam used to own a separate DOM shell in app.js. Store it separately and
  // leave the legacy app preference on default so reloads cannot remount it.
  if (next === 'steam') {
    safeSet(OVERHAUL_THEME_KEY, 'steam');
    safeSet('simpleshare-theme', 'default');
  } else {
    safeRemove(OVERHAUL_THEME_KEY);
    safeSet('simpleshare-theme', next);
  }

  syncThemePicker(next);
  if (announce) showUiToast(`Theme: ${THEME_NAMES[next] || next}`);
}

function initialTheme() {
  const overhaulTheme = safeGet(OVERHAUL_THEME_KEY);
  if (THEME_IDS.has(overhaulTheme)) return overhaulTheme;
  const active = document.documentElement.dataset.theme;
  if (THEME_IDS.has(active)) return active;
  const legacy = safeGet('simpleshare-theme', 'default');
  return THEME_IDS.has(legacy) ? legacy : 'default';
}

// compat.js is intentionally retained for browser/media fixes, but its older
// room geometry rules are no longer allowed to own layout. This style is
// appended after compat.js, so the new canonical shell remains authoritative.
const guardStyle = document.createElement('style');
guardStyle.id = 'simpleshare-ui-overhaul-guard';
guardStyle.textContent = `
  #peopleBubbles.compat-people-bubbles { display: none !important; }

  html body #room.room.no-members {
    grid-template-columns: var(--rail-w) minmax(0,1fr) !important;
    grid-template-areas: "rail main" !important;
    width: auto !important;
    max-width: none !important;
  }
  html body #room.room.no-members .people-panel { display: none !important; }
  html body #room.room.no-members .call-dock {
    left: calc(var(--rail-w) + (100vw - var(--rail-w)) / 2) !important;
  }
  html body #room.room.no-members .settings-panel {
    left: auto !important;
    right: 14px !important;
  }

  @media (max-width: 860px) {
    html body #room.room.no-members {
      grid-template-columns: var(--rail-w) minmax(0,1fr) !important;
      grid-template-areas: "rail main" !important;
    }
    html body #room.room.no-members .call-dock {
      left: calc(var(--rail-w) + (100vw - var(--rail-w)) / 2) !important;
    }
    html body #room.room.no-members .settings-panel {
      left: auto !important;
      right: 12px !important;
    }
  }

  @media (max-width: 620px) {
    html body #room.room.no-members { display: block !important; }
    html body #room.room.no-members .call-dock { left: 50% !important; }
    html body #room.room.no-members .settings-panel {
      left: 8px !important;
      right: 8px !important;
    }
  }
`;
document.head.appendChild(guardStyle);

const theme = initialTheme();
applyUiTheme(theme);

for (const option of document.querySelectorAll('[data-theme-choice]')) {
  option.addEventListener('click', () => {
    applyUiTheme(option.dataset.themeChoice, { announce: true });
  });
}

byId('settingsCloseBtn')?.addEventListener('click', () => {
  byId('settingsPanel')?.classList.add('hidden');
});

byId('emptyInviteBtn')?.addEventListener('click', () => {
  byId('copyBtn')?.click();
});

// The room id is already in the public invite URL, so this is presentation
// only; it does not add any network work.
const roomId = new URLSearchParams(location.search).get('room');
if (roomId && byId('roomCode')) {
  byId('roomCode').textContent = `Room · ${roomId.slice(0, 6).toUpperCase()}`;
}

const room = byId('room');
const membersButton = byId('membersBtn');
let initialMemberLayoutMigrated = false;

function syncMembersButton() {
  if (!room || !membersButton) return;
  const visible = !room.classList.contains('no-members');
  membersButton.setAttribute('aria-pressed', visible ? 'true' : 'false');
  membersButton.title = visible ? 'Hide members' : 'Show members';
}

function migrateInitialMemberLayout() {
  if (!room || initialMemberLayoutMigrated || room.classList.contains('hidden')) return;

  // compat.js historically forced every room into a collapsed members view.
  // Undo that once when the room first opens. After this point the normal
  // Members button is free to persist the user's own choice.
  initialMemberLayoutMigrated = true;
  room.dataset.overhaulMembersMigrated = '1';
  room.classList.remove('no-members');
  safeSet('simpleshare-hide-members', '0');
  byId('peopleBubbles')?.remove();
  syncMembersButton();
}

if (room) {
  const roomObserver = new MutationObserver(() => {
    migrateInitialMemberLayout();
    syncMembersButton();
  });
  roomObserver.observe(room, { attributes: true, attributeFilter: ['class'] });
  queueMicrotask(migrateInitialMemberLayout);
  syncMembersButton();
}
