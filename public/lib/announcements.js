export function createAnnouncements(banner, text, close, maintenance = {}) {
  let maintenanceDismissed = '';
  let maintenanceId = '';
  let revision = -1;
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
  maintenance.close?.addEventListener('click', () => {
    maintenanceDismissed = maintenanceId;
    maintenance.card.hidden = true;
  });
  const updateState = (data) => {
    if (Number.isFinite(data.controlRevision)) {
      if (data.controlRevision < revision) return;
      revision = data.controlRevision;
    } else if (revision > 0) return;
    update(data.announcement);
    if (maintenance.card && Object.hasOwn(data, 'maintenance')) {
      const warning = data.maintenance;
      maintenanceId = warning?.enabled ? warning.id : '';
      maintenance.card.hidden = !maintenanceId || maintenanceDismissed === maintenanceId;
      maintenance.text.textContent = typeof warning?.text === 'string' ? warning.text : '';
    }
  };
  const stop = () => {
    generation++;
    clearInterval(poll);
    clearTimeout(expiry);
    poll = null;
    inFlight = false;
    update(null);
    if (maintenance.card) maintenance.card.hidden = true;
    revision = -1;
  };
  return {
    update,
    updateState,
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
          if (sequence === generation) updateState(data);
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
