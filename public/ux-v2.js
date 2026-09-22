/*
 * SimpleShare UX v2
 * UI-only orchestration layered on top of the existing room/media engine.
 * No signalling, PartyTracks, TURN, budget or capture code is changed here.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const room = $('room');
  const stage = document.querySelector('.stage');
  const grid = $('grid');
  const people = $('people');
  const empty = $('empty');
  const hint = document.querySelector('.stage-hint');
  const dock = document.querySelector('.call-dock');
  const settings = $('settingsPanel');
  const membersBtn = $('membersBtn');
  if (!room || !stage || !grid || !people) return;

  const FOCUS_LIMIT = 3;
  const MEMBER_DEFAULT_KEY = 'simpleshare-ux2-members-defaulted';
  const WATCH_KEY = `simpleshare-ux2-watches-${new URLSearchParams(location.search).get('room') || 'room'}`;
  const focused = new Set();
  let trayExpanded = false;
  let syncQueued = false;
  let dockTimer = 0;
  let wakeLock = null;
  let restoredWatches = false;

  const normalizeName = value => String(value || '')
    .replace(/\s*\(you\)\s*$/i, '')
    .replace(/\s+is\s+live\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  function safeGet(key, fallback = null) {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  }
  function safeSet(key, value) {
    try { localStorage.setItem(key, value); } catch {}
  }
  function showToast(message) {
    const toast = $('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 2200);
  }
  function isMobile() {
    return matchMedia('(max-width: 680px)').matches || matchMedia('(pointer: coarse)').matches && innerWidth < 900;
  }

  // -------------------------------------------------------------------------
  // Home preview: example names, never the developer/test names.
  // -------------------------------------------------------------------------
  const previewNames = [
    'Rowan','Jules','Casey','Mika','Noah','Ari','Sam','Alex','Riley','Nico',
    'Jamie','Morgan','Taylor','Kai','Emery','Quinn','Robin','Drew',
  ];
  function randomPreviewNames() {
    const nodes = [...document.querySelectorAll('.preview-people span')];
    if (!nodes.length) return;
    const pool = [...previewNames];
    for (const node of nodes) {
      const idx = Math.floor(Math.random() * pool.length);
      const name = pool.splice(idx, 1)[0] || 'Guest';
      const live = node.querySelector('em') ? '<em></em>' : '';
      node.innerHTML = `<i>${name.slice(0, 1).toUpperCase()}</i>${name}${live}`;
    }
  }
  randomPreviewNames();

  // -------------------------------------------------------------------------
  // Members: collapsed by default once after the upgrade, then respect choice.
  // -------------------------------------------------------------------------
  function syncMemberButton() {
    const visible = !room.classList.contains('no-members');
    membersBtn?.setAttribute('aria-pressed', visible ? 'true' : 'false');
    membersBtn?.setAttribute('aria-expanded', visible ? 'true' : 'false');
    document.body.classList.toggle('ss-members-open', visible);
    syncBackdrop();
  }
  if (safeGet(MEMBER_DEFAULT_KEY) !== '1') {
    room.classList.add('no-members');
    safeSet('simpleshare-hide-members', '1');
    safeSet(MEMBER_DEFAULT_KEY, '1');
  }
  syncMemberButton();

  // Mobile members sheet gets its own close affordance; relying on a hidden
  // header toggle or only the dimmed backdrop is unnecessarily indirect.
  const peoplePanel = document.querySelector('.people-panel');
  const peopleHead = peoplePanel?.querySelector('.panel-head');
  if (peopleHead && !peopleHead.querySelector('.ss-members-close')) {
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ss-members-close';
    close.setAttribute('aria-label', 'Close members');
    close.textContent = '×';
    close.addEventListener('click', () => {
      room.classList.add('no-members');
      safeSet('simpleshare-hide-members', '1');
      syncMemberButton();
    });
    peopleHead.appendChild(close);
  }

  // -------------------------------------------------------------------------
  // Focus model: up to three live streams, all equal in the primary row.
  // Core app focus is intercepted in capture phase so its old single-big-tile
  // vertical layout never gets a chance to run.
  // -------------------------------------------------------------------------
  const tileName = tile => normalizeName(
    tile.querySelector('.idle-name')?.textContent ||
    tile.querySelector('.tile-name')?.textContent ||
    tile.dataset.ssName || ''
  );

  function validFocusTile(tile) {
    return tile?.isConnected && tile.classList.contains('tile') && !tile.classList.contains('idle');
  }

  function toggleFocus(tile) {
    if (!validFocusTile(tile)) return;
    if (focused.has(tile)) {
      focused.delete(tile);
    } else {
      if (focused.size >= FOCUS_LIMIT) {
        showToast('You can focus up to 3 streams at once.');
        return;
      }
      focused.add(tile);
    }
    trayExpanded = false;
    applyFocusLayout();
  }

  function ensureTrayToggle() {
    let button = stage.querySelector('.ss-tray-toggle');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'ss-tray-toggle hidden';
      button.addEventListener('click', () => {
        trayExpanded = !trayExpanded;
        applyFocusLayout();
      });
      stage.appendChild(button);
    }
    return button;
  }

  function applyFocusLayout() {
    for (const tile of [...focused]) if (!validFocusTile(tile)) focused.delete(tile);
    const slots = [...grid.children].filter(el => el.matches('.tile, .ss-presence-tile'));
    const hasFocus = focused.size > 0;
    const tray = slots.filter(el => !focused.has(el));
    const trayCols = isMobile() ? 2 : 4;
    const toggle = ensureTrayToggle();

    grid.classList.toggle('ss-focus-mode', hasFocus);
    grid.classList.toggle('ss-tray-expanded', hasFocus && trayExpanded);
    grid.classList.remove('ss-focus-count-1','ss-focus-count-2','ss-focus-count-3');
    if (hasFocus) grid.classList.add(`ss-focus-count-${focused.size}`);
    document.body.classList.toggle('ss-focus-active', hasFocus);
    grid.style.setProperty('--ss-focus-count', String(Math.max(1, focused.size)));
    grid.style.setProperty('--ss-tray-cols', String(trayCols));

    for (const slot of slots) {
      const primary = focused.has(slot);
      slot.classList.toggle('ss-focused', primary);
      slot.classList.toggle('ss-tray-item', hasFocus && !primary);
      slot.classList.remove('ss-tray-extra');
      if (slot.classList.contains('tile')) {
        // Neutralise any legacy focus state left by an older handler/session.
        slot.classList.remove('big');
        const focusButton = slot.querySelector('.tile-focus');
        if (focusButton) {
          focusButton.setAttribute('aria-pressed', primary ? 'true' : 'false');
          focusButton.title = primary ? 'Remove from focus' : 'Focus this stream';
          focusButton.setAttribute('aria-label', primary ? 'Remove stream from focus' : 'Focus this stream');
        }
      }
    }

    if (hasFocus) {
      tray.forEach((slot, index) => {
        if (!trayExpanded && index >= trayCols) slot.classList.add('ss-tray-extra');
      });
      const hiddenCount = Math.max(0, tray.length - trayCols);
      toggle.classList.toggle('hidden', hiddenCount === 0);
      toggle.textContent = trayExpanded ? 'Show less' : `Show ${hiddenCount} more`;
      toggle.setAttribute('aria-expanded', trayExpanded ? 'true' : 'false');
      if (hint) hint.textContent = `${focused.size}/3 focused · click a focused stream to release it`;
    } else {
      toggle.classList.add('hidden');
      if (hint) hint.textContent = 'Click a live stream to focus · up to 3 at once';
    }

    requestAnimationFrame(fitGrid);
  }

  // Capture before app.js's card click listener.
  grid.addEventListener('click', event => {
    const tile = event.target.closest('.tile');
    if (!tile || tile.classList.contains('idle')) return;
    const interactive = event.target.closest('button, input, label, a, select');
    const explicitFocus = event.target.closest('.tile-focus');
    if (interactive && !explicitFocus) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    toggleFocus(tile);
  }, true);

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !focused.size) return;
    focused.clear();
    trayExpanded = false;
    applyFocusLayout();
  }, true);

  // -------------------------------------------------------------------------
  // Every connected member owns a visual slot, even when not sharing.
  // -------------------------------------------------------------------------
  function makePresenceTile(name, avatarText, liveClass) {
    const tile = document.createElement('article');
    tile.className = 'ss-presence-tile';
    tile.dataset.ssName = name;
    tile.setAttribute('aria-label', `${name}, connected, not sharing`);
    tile.innerHTML = `
      <div class="ss-presence-avatar${liveClass ? ' live' : ''}">${(avatarText || name || '?').slice(0,1).toUpperCase()}</div>
      <strong></strong>
      <span><i></i> Connected · not sharing</span>
    `;
    tile.querySelector('strong').textContent = name || 'Guest';
    return tile;
  }

  function syncPresenceSlots() {
    const rows = [...people.querySelectorAll('.person')];
    const memberList = rows.map(row => ({
      name: normalizeName(row.querySelector('.person-name')?.textContent),
      avatar: row.querySelector('.person-avatar')?.textContent?.trim() || '?',
      live: row.querySelector('.person-avatar')?.classList.contains('live') || false,
    })).filter(p => p.name);

    const streamTiles = [...grid.querySelectorAll(':scope > .tile')];
    streamTiles.forEach(tile => {
      tile.classList.add('ss-stream-tile');
      tile.dataset.ssName = tileName(tile);
    });

    // Duplicate display names are legal. Match one stream tile to one occurrence,
    // then keep a stable keyed placeholder for each remaining roster occurrence.
    const unmatched = [...streamTiles];
    const occurrences = new Map();
    const desired = new Map();
    for (const member of memberList) {
      const lower = member.name.toLocaleLowerCase();
      const occurrence = (occurrences.get(lower) || 0) + 1;
      occurrences.set(lower, occurrence);
      let index = unmatched.findIndex(tile => tileName(tile).toLocaleLowerCase() === lower);
      if (index >= 0) {
        unmatched.splice(index, 1);
        continue;
      }
      const key = `${lower}::${occurrence}`;
      desired.set(key, member);
    }

    const existing = new Map([...grid.querySelectorAll(':scope > .ss-presence-tile')].map(node => [node.dataset.ssKey, node]));
    for (const [key, node] of existing) {
      if (!desired.has(key)) node.remove();
    }
    for (const [key, member] of desired) {
      let placeholder = existing.get(key);
      if (!placeholder || !placeholder.isConnected) {
        placeholder = makePresenceTile(member.name, member.avatar, member.live);
        placeholder.dataset.ssKey = key;
        grid.appendChild(placeholder);
      } else {
        placeholder.dataset.ssName = member.name;
        placeholder.setAttribute('aria-label', `${member.name}, connected, not sharing`);
        placeholder.querySelector('strong').textContent = member.name;
        const avatar = placeholder.querySelector('.ss-presence-avatar');
        avatar.textContent = (member.avatar || member.name || '?').slice(0,1).toUpperCase();
        avatar.classList.toggle('live', Boolean(member.live));
      }
    }

    const slotCount = grid.querySelectorAll(':scope > .tile, :scope > .ss-presence-tile').length;
    const hasRoomPeople = memberList.length > 0;
    // The original empty state only knows about streams. UX v2 knows about users.
    empty?.classList.toggle('hidden', hasRoomPeople || slotCount > 0);
    grid.classList.toggle('hidden', !(hasRoomPeople || slotCount > 0));
    grid.dataset.ssSlots = String(slotCount);

    restoreWantedStreams();
    applyFocusLayout();
  }

  function fitGrid() {
    const slots = [...grid.children].filter(el => el.matches('.tile, .ss-presence-tile') && !el.classList.contains('ss-tray-extra'));
    if (!slots.length) return;
    const w = Math.max(1, grid.clientWidth);
    const h = Math.max(1, grid.clientHeight);

    if (focused.size) {
      const trayCount = slots.filter(el => !focused.has(el)).length;
      const trayCols = isMobile() ? 2 : 4;
      const rows = trayCount ? Math.max(1, Math.ceil(trayCount / trayCols)) : 0;
      const cappedRows = trayExpanded ? rows : Math.min(rows, 1);
      const gap = isMobile() ? 6 : 9;
      const available = Math.max(0, h - gap * Math.max(0, cappedRows));
      const maxTrayTotal = Math.min(isMobile() ? 180 : 250, available * (isMobile() ? .34 : .31));
      const trayH = cappedRows ? Math.max(isMobile() ? 58 : 68, Math.floor(maxTrayTotal / cappedRows)) : 0;
      const rowsText = cappedRows ? `minmax(0,1fr) repeat(${cappedRows}, ${trayH}px)` : 'minmax(0,1fr)';
      grid.style.gridTemplateRows = rowsText;
      grid.style.gridTemplateColumns = 'repeat(12, minmax(0, 1fr))';
      return;
    }

    const n = slots.length;
    let cols;
    if (isMobile()) cols = n === 1 ? 1 : 2;
    else {
      const aspect = w / h;
      cols = Math.ceil(Math.sqrt(n * Math.max(.9, aspect * .78)));
      cols = Math.max(1, Math.min(n, Math.min(5, cols)));
      if (n === 3 && w > 1000) cols = 3;
    }
    const rows = Math.ceil(n / cols);
    grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    grid.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
  }

  // -------------------------------------------------------------------------
  // Dock: invisible at rest on pointer devices, instantly available on intent.
  // Touch devices get a persistent compact action bar instead of hover logic.
  // -------------------------------------------------------------------------
  function revealDock(ms = 1700) {
    if (!dock || isMobile()) return;
    dock.classList.add('ss-dock-active');
    clearTimeout(dockTimer);
    dockTimer = setTimeout(() => dock.classList.remove('ss-dock-active'), ms);
  }
  stage.addEventListener('pointermove', event => {
    if (isMobile()) return;
    const box = stage.getBoundingClientRect();
    if (box.bottom - event.clientY < 130) revealDock();
  }, {passive:true});
  dock?.addEventListener('pointerenter', () => revealDock(4000));
  dock?.addEventListener('focusin', () => revealDock(4000));
  dock?.addEventListener('pointerleave', () => revealDock(700));

  // -------------------------------------------------------------------------
  // Mobile sheets/backdrop. Desktop keeps the existing side panel behaviour.
  // -------------------------------------------------------------------------
  const backdrop = document.createElement('button');
  backdrop.type = 'button';
  backdrop.className = 'ss-sheet-backdrop';
  backdrop.setAttribute('aria-label', 'Close panel');
  document.body.appendChild(backdrop);

  function syncBackdrop() {
    const memberOpen = !room.classList.contains('no-members');
    const settingsOpen = settings && !settings.classList.contains('hidden');
    const show = isMobile() && (memberOpen || settingsOpen);
    backdrop.classList.toggle('show', Boolean(show));
  }
  backdrop.addEventListener('click', () => {
    if (settings && !settings.classList.contains('hidden')) settings.classList.add('hidden');
    if (!room.classList.contains('no-members')) {
      room.classList.add('no-members');
      safeSet('simpleshare-hide-members', '1');
    }
    syncMemberButton();
    syncBackdrop();
  });

  const roomClassObserver = new MutationObserver(() => {
    syncMemberButton();
    if (!room.classList.contains('hidden')) acquireWakeLock();
  });
  roomClassObserver.observe(room, {attributes:true, attributeFilter:['class']});
  if (settings) new MutationObserver(syncBackdrop).observe(settings, {attributes:true, attributeFilter:['class']});

  // -------------------------------------------------------------------------
  // Best-effort mobile/background recovery. Browsers may still suspend a tab;
  // the goal is to resume media and restore explicitly watched streams quickly.
  // -------------------------------------------------------------------------
  function savedWatchNames() {
    try { return new Set(JSON.parse(sessionStorage.getItem(WATCH_KEY) || '[]')); }
    catch { return new Set(); }
  }
  function saveWatchNames(set) {
    try { sessionStorage.setItem(WATCH_KEY, JSON.stringify([...set].slice(0, 10))); } catch {}
  }
  function rememberWatch(tile, watching) {
    const name = tileName(tile);
    if (!name) return;
    const set = savedWatchNames();
    if (watching) set.add(name); else set.delete(name);
    saveWatchNames(set);
  }

  grid.addEventListener('click', event => {
    const tile = event.target.closest('.tile');
    if (!tile) return;
    if (event.target.closest('.idle-watch')) rememberWatch(tile, true);
    if (event.target.closest('.tile-stop')) rememberWatch(tile, false);
  }, false);

  function restoreWantedStreams() {
    const wanted = savedWatchNames();
    if (!wanted.size) return;
    for (const tile of grid.querySelectorAll('.tile.idle')) {
      if (!wanted.has(tileName(tile))) continue;
      const button = tile.querySelector('.idle-watch:not(:disabled)');
      if (button && !button.dataset.ssRestoreQueued) {
        button.dataset.ssRestoreQueued = '1';
        setTimeout(() => {
          delete button.dataset.ssRestoreQueued;
          if (document.visibilityState === 'visible' && tile.isConnected && tile.classList.contains('idle') && !button.disabled) button.click();
        }, restoredWatches ? 450 : 900);
      }
    }
    restoredWatches = true;
  }

  async function nudgeMedia() {
    if (document.hidden) return;
    for (const media of grid.querySelectorAll('video, audio')) {
      if (!media.srcObject) continue;
      try { await media.play(); } catch {}
    }
    restoreWantedStreams();
  }

  async function acquireWakeLock() {
    // Keep a foreground phone awake during a room session. Desktop users do not
    // need SimpleShare changing their normal display-sleep behaviour.
    if (!isMobile() || document.hidden || !room || room.classList.contains('hidden') || !('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; }, {once:true});
    } catch {}
  }
  function releaseWakeLock() {
    try { wakeLock?.release(); } catch {}
    wakeLock = null;
  }
  // app.js correctly preserves normal bfcache sessions, but its separate P2P
  // shutdown listener still ran on pagehide. Catch only persisted page hides
  // before the bubble phase so returning from another page/app does not throw
  // away an otherwise recoverable direct-media session. Real unloads are left
  // completely untouched.
  window.addEventListener('pagehide', event => {
    if (!event.persisted) return;
    releaseWakeLock();
    event.stopImmediatePropagation();
  }, {capture:true});

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseWakeLock();
    else {
      setTimeout(nudgeMedia, 140);
      acquireWakeLock();
    }
  });
  window.addEventListener('pageshow', () => setTimeout(nudgeMedia, 180));
  window.addEventListener('online', () => setTimeout(nudgeMedia, 450));
  window.addEventListener('focus', () => setTimeout(nudgeMedia, 120));
  window.addEventListener('resize', () => { fitGrid(); syncBackdrop(); });
  screen.orientation?.addEventListener?.('change', () => setTimeout(fitGrid, 180));
  acquireWakeLock();

  // Roster/tile updates can arrive in bursts. One frame-coalesced sync prevents
  // placeholder flicker while a participant becomes live or stops sharing.
  function scheduleSync() {
    if (syncQueued) return;
    syncQueued = true;
    requestAnimationFrame(() => {
      syncQueued = false;
      syncPresenceSlots();
    });
  }
  const observer = new MutationObserver(scheduleSync);
  observer.observe(people, {childList:true, subtree:true, characterData:true});
  observer.observe(grid, {childList:true, subtree:true, characterData:true});

  // We no longer need the old floating people bubble row. Its data source is now
  // represented by actual canvas slots.
  document.getElementById('peopleBubbles')?.remove();
  const bodyObserver = new MutationObserver(() => document.getElementById('peopleBubbles')?.remove());
  bodyObserver.observe(document.body, {childList:true, subtree:true});

  scheduleSync();
})();
