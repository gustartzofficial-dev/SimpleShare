// SimpleShare shell bridge. The media/signalling stack lives in app.js; this
// file only keeps theme-picker and shell affordances in sync with the canonical
// room DOM. UX v2 owns the responsive room geometry.
const OVERHAUL_THEME_KEY = 'simpleshare-theme-overhaul';
const THEME_IDS = new Set([
  'default','teamspeak','ios','xp','win98','skype','terminal','aqua','steam','youtube','holo',
]);
const THEME_NAMES = {
  default:'Midnight', teamspeak:'TeamSpeak 3', ios:'iOS Glass', xp:'Windows XP',
  win98:'Windows 98', skype:'Old Skype', terminal:'CRT Terminal', aqua:'Mac OS X Aqua',
  steam:'Steam Classic', youtube:'YouTube 2012', holo:'Android Holo',
};
const byId = id => document.getElementById(id);
const safeGet = (key, fallback=null) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const safeSet = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
const safeRemove = key => { try { localStorage.removeItem(key); } catch {} };

function toast(message) {
  const el = byId('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 1800);
}
function syncPicker(themeId) {
  document.querySelectorAll('[data-theme-choice]').forEach(option => {
    const active = option.dataset.themeChoice === themeId;
    option.classList.toggle('active', active);
    option.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}
function applyUiTheme(themeId, {announce=false}={}) {
  const next = THEME_IDS.has(themeId) ? themeId : 'default';
  document.documentElement.dataset.theme = next;
  if (next === 'steam') {
    safeSet(OVERHAUL_THEME_KEY, 'steam');
    safeSet('simpleshare-theme', 'default');
  } else {
    safeRemove(OVERHAUL_THEME_KEY);
    safeSet('simpleshare-theme', next);
  }
  syncPicker(next);
  if (announce) toast(`Theme: ${THEME_NAMES[next] || next}`);
}
function initialTheme() {
  const overhaul = safeGet(OVERHAUL_THEME_KEY);
  if (THEME_IDS.has(overhaul)) return overhaul;
  const active = document.documentElement.dataset.theme;
  if (THEME_IDS.has(active)) return active;
  const legacy = safeGet('simpleshare-theme', 'default');
  return THEME_IDS.has(legacy) ? legacy : 'default';
}

applyUiTheme(initialTheme());
document.querySelectorAll('[data-theme-choice]').forEach(option => {
  option.addEventListener('click', () => applyUiTheme(option.dataset.themeChoice, {announce:true}));
});
byId('settingsCloseBtn')?.addEventListener('click', () => byId('settingsPanel')?.classList.add('hidden'));
byId('emptyInviteBtn')?.addEventListener('click', () => byId('copyBtn')?.click());

const roomId = new URLSearchParams(location.search).get('room');
if (roomId && byId('roomCode')) byId('roomCode').textContent = `Room · ${roomId.slice(0, 6).toUpperCase()}`;

function syncMembersButton() {
  const room = byId('room'), button = byId('membersBtn');
  if (!room || !button) return;
  const visible = !room.classList.contains('no-members');
  button.setAttribute('aria-pressed', visible ? 'true' : 'false');
  button.title = visible ? 'Hide members' : 'Show members';
}
const room = byId('room');
if (room) {
  const observer = new MutationObserver(syncMembersButton);
  observer.observe(room, {attributes:true, attributeFilter:['class']});
  syncMembersButton();
}
