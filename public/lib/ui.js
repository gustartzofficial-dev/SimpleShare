import { storage } from './room.js';
const icons = new Set([
  'speaker-high',
  'speaker-slash',
  'warning-circle',
  'arrows-out-simple',
  'speaker-low',
  'corners-out',
]);
export function icon(name) {
  return `<i class="ph ph-${icons.has(name) ? name : 'warning-circle'}" aria-hidden="true"></i>`;
}
export function applyAppearance(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  storage.set('simpleshare-theme', next);
  document.querySelector('meta[name="theme-color"]').content =
    next === 'dark' ? '#1c201c' : '#f6f3ec';
  document
    .querySelectorAll('[data-theme-choice]')
    .forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === next)),
    );
  document.querySelectorAll('.theme-toggle').forEach((button) => {
    button.setAttribute('aria-label', `Switch to ${next === 'dark' ? 'light' : 'dark'} appearance`);
    button.innerHTML = `<i class="ph ph-${next === 'dark' ? 'sun' : 'moon'}" aria-hidden="true"></i>`;
  });
}
export function setupAppearance() {
  const saved = storage.get('simpleshare-theme');
  applyAppearance(
    ['light', 'dark'].includes(saved)
      ? saved
      : matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light',
  );
  document
    .querySelectorAll('[data-theme-choice]')
    .forEach((button) =>
      button.addEventListener('click', () => applyAppearance(button.dataset.themeChoice)),
    );
  document
    .querySelectorAll('.theme-toggle')
    .forEach((button) =>
      button.addEventListener('click', () =>
        applyAppearance(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'),
      ),
    );
}
