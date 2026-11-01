const clamp = (value, fallback = 1) =>
  Number.isFinite(Number(value)) ? Math.max(0, Math.min(1, Number(value))) : fallback;

export function createStreamAudioPreferences(storage) {
  const key = 'simpleshare-stream-audio';
  let entries = [];
  try {
    const saved = JSON.parse(storage.get(key) || '[]');
    if (Array.isArray(saved))
      entries = saved
        .filter(
          (entry) =>
            Array.isArray(entry) &&
            typeof entry[0] === 'string' &&
            entry[1] &&
            typeof entry[1] === 'object',
        )
        .slice(-64);
  } catch {}
  const preferences = new Map(entries);
  const get = (id) => {
    const value = preferences.get(id);
    return { volume: clamp(value?.volume), muted: value?.muted === true };
  };
  return {
    get,
    set(id, patch) {
      const value = { ...get(id), ...patch };
      const next = { volume: clamp(value.volume), muted: value.muted === true };
      preferences.delete(id);
      preferences.set(id, next);
      while (preferences.size > 64) preferences.delete(preferences.keys().next().value);
      try {
        storage.set(key, JSON.stringify([...preferences]));
      } catch {}
      return next;
    },
  };
}

export function effectiveStreamAudio(preference, master, blocked = false) {
  const volume = clamp(preference.volume) * clamp(master.volume);
  return { volume, muted: preference.muted || master.muted || blocked || volume === 0 };
}
