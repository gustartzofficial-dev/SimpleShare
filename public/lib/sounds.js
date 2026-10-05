import { storage } from './room.js';
let context,
  quietUntil = 0,
  lastSound = 0;
let enabled = storage.get('simpleshare-sfx') === 'on';
export const soundsEnabled = () => enabled;
export function setSoundsEnabled(on) {
  enabled = on;
  storage.set('simpleshare-sfx', on ? 'on' : 'off');
}
export function quietSounds(ms = 1500) {
  quietUntil = Date.now() + ms;
}
export function unlockSounds() {
  if (!enabled) return;
  try {
    context ||= new AudioContext();
    context.resume().catch(() => {});
  } catch {}
}
export function playSound(name) {
  if (
    !enabled ||
    document.hidden ||
    Date.now() < quietUntil ||
    Date.now() - lastSound < 500 ||
    !context
  )
    return;
  lastSound = Date.now();
  const oscillator = context.createOscillator(),
    gain = context.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = name.includes('leave') || name.includes('stop') ? 340 : 540;
  gain.gain.setValueAtTime(0, context.currentTime);
  gain.gain.linearRampToValueAtTime(0.055, context.currentTime + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.18);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.2);
  oscillator.onended = () => {
    oscillator.disconnect();
    gain.disconnect();
  };
}
