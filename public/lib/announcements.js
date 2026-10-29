export function createAnnouncements(banner, text, close) {
  let dismissed = '';
  let current = null;
  let expiry;
  let poll;
  let generation = 0;
  let inFlight = false;
  const update = (message) => {
    clearTimeout(expiry);
    const valid =
      message &&
      typeof message.id === 'string' &&
      typeof message.text === 'string' &&
      Number.isFinite(message.expiresAt) &&
      message.expiresAt > Date.now();
    current = valid ? message : null;
    banner.hidden = !current || current.id === dismissed;
    text.textContent = current?.text || '';
    if (current)
      expiry = setTimeout(() => update(null), Math.min(86_400_000, current.expiresAt - Date.now()));
  };
  close.addEventListener('click', () => {
    dismissed = current?.id || '';
    banner.hidden = true;
  });
  const stop = () => {
    generation++;
    clearInterval(poll);
    clearTimeout(expiry);
    poll = null;
    inFlight = false;
    update(null);
  };
  return {
    update,
    stop,
    start(base) {
      stop();
      const sequence = generation;
      const check = async () => {
        if (inFlight || sequence !== generation) return;
        inFlight = true;
        try {
          const response = await fetch(base + '/api/announcements', {
            cache: 'no-store',
            signal: AbortSignal.timeout(8000),
          });
          if (!response.ok) return;
          const data = await response.json();
          if (sequence === generation) update(data.announcement);
        } catch {
          /* A message outage must not interrupt sharing. */
        } finally {
          if (sequence === generation) inFlight = false;
        }
      };
      check();
      poll = setInterval(check, 30_000);
    },
  };
}
