const { Room, RoomEvent, Track } = window.LivekitClient;

const els = {
  home: document.querySelector('#home'),
  room: document.querySelector('#room'),
  createRoom: document.querySelector('#createRoom'),
  leaveRoom: document.querySelector('#leaveRoom'),
  statusPill: document.querySelector('#statusPill'),
  statusText: document.querySelector('#statusPill b'),
  participantCount: document.querySelector('#participantCount'),
  shareScreen: document.querySelector('#shareScreen'),
  emptyShareButton: document.querySelector('#emptyShareButton'),
  stopSharing: document.querySelector('#stopSharing'),
  inviteLink: document.querySelector('#inviteLink'),
  copyInvite: document.querySelector('#copyInvite'),
  peopleList: document.querySelector('#peopleList'),
  emptyState: document.querySelector('#emptyState'),
  streamGrid: document.querySelector('#streamGrid'),
  focusView: document.querySelector('#focusView'),
  focusMount: document.querySelector('#focusMount'),
  backToGrid: document.querySelector('#backToGrid'),
  endedPanel: document.querySelector('#endedPanel'),
  audioUnlock: document.querySelector('#audioUnlock'),
  toast: document.querySelector('#toast'),
  streamCardTemplate: document.querySelector('#streamCardTemplate'),
};

const state = {
  roomId: null,
  livekit: null,
  identity: null,
  streams: new Map(),
  audioTracks: new Map(),
  focusedKey: null,
  statsTimer: null,
};

function show(view) {
  els.home.classList.toggle('active', view === 'home');
  els.room.classList.toggle('active', view === 'room');
}

function setStatus(text, mode = '') {
  els.statusText.textContent = text;
  els.statusPill.classList.remove('connected', 'sharing', 'reconnecting');
  if (mode) els.statusPill.classList.add(mode);
}

function toast(text) {
  els.toast.textContent = text;
  els.toast.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.remove('show'), 2300);
}

function makeRoomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function shortIdentity(identity) {
  if (!identity) return 'Guest';
  const clean = identity.replaceAll('-', '');
  return `Guest ${clean.slice(0, 4).toUpperCase()}`;
}

function participantLabel(participant) {
  if (!participant) return 'Guest';
  if (participant === state.livekit?.localParticipant) return 'You';
  return participant.name || shortIdentity(participant.identity);
}

function participantInitial(participant) {
  const label = participantLabel(participant);
  return label === 'You' ? 'Y' : label.replace('Guest ', '').slice(0, 2);
}

function streamKey(participant, publication) {
  return `${participant.identity}:${publication.trackSid || publication.trackName || 'screen'}`;
}

function isLocalSharing() {
  return Boolean(state.livekit?.localParticipant?.isScreenShareEnabled);
}

function updateShellUi() {
  if (!state.livekit) return;
  const count = state.livekit.remoteParticipants.size + 1;
  const streamCount = state.streams.size;
  const localSharing = isLocalSharing();

  els.participantCount.textContent = `${count} ${count === 1 ? 'person' : 'people'}`;
  els.shareScreen.classList.toggle('hidden', localSharing);
  els.stopSharing.classList.toggle('hidden', !localSharing);
  els.emptyShareButton.disabled = localSharing;

  if (localSharing) setStatus(`You’re live · ${streamCount} ${streamCount === 1 ? 'stream' : 'streams'}`, 'sharing');
  else if (streamCount > 0) setStatus(`${streamCount} live ${streamCount === 1 ? 'stream' : 'streams'}`, 'sharing');
  else setStatus('Room ready', 'connected');

  renderPeople();
  renderStreamLayout();
}

function renderPeople() {
  if (!state.livekit) return;
  const participants = [state.livekit.localParticipant, ...state.livekit.remoteParticipants.values()];
  els.peopleList.replaceChildren();

  for (const participant of participants) {
    const item = document.createElement('div');
    item.className = 'person-row';
    const isStreaming = participant.isScreenShareEnabled;
    item.innerHTML = `
      <span class="person-avatar">${participantInitial(participant)}</span>
      <span class="person-name">${participantLabel(participant)}</span>
      ${isStreaming ? '<span class="person-live">LIVE</span>' : '<span class="person-dot"></span>'}
    `;
    els.peopleList.appendChild(item);
  }
}

function renderStreamLayout() {
  const hasStreams = state.streams.size > 0;
  const isFocused = Boolean(state.focusedKey && state.streams.has(state.focusedKey));

  els.endedPanel.classList.add('hidden');
  els.emptyState.classList.toggle('hidden', hasStreams || isFocused);
  els.streamGrid.classList.toggle('hidden', !hasStreams || isFocused);
  els.focusView.classList.toggle('hidden', !isFocused);

  if (!isFocused) {
    els.streamGrid.classList.toggle('single-stream', state.streams.size === 1);
    els.streamGrid.classList.toggle('two-streams', state.streams.size === 2);
  }
}

function makeStreamCard(key, participant, track, publication, isLocal = false) {
  const fragment = els.streamCardTemplate.content.cloneNode(true);
  const card = fragment.querySelector('.stream-card');
  const video = fragment.querySelector('video');
  const loading = fragment.querySelector('.stream-loading');
  const title = fragment.querySelector('.stream-copy strong');
  const avatar = fragment.querySelector('.stream-avatar');
  const expand = fragment.querySelector('.expand-stream');
  const quality = fragment.querySelector('.quality-badge');

  card.dataset.streamKey = key;
  title.textContent = isLocal ? 'Your stream' : `${participantLabel(participant)}’s stream`;
  avatar.textContent = participantInitial(participant);
  quality.textContent = 'Up to 720p · 30';
  video.muted = true;

  track.attach(video);
  video.addEventListener('loadeddata', () => loading.classList.add('hidden'), { once: true });
  video.play().catch(() => {});
  expand.addEventListener('click', (event) => {
    event.stopPropagation();
    focusStream(key);
  });
  card.querySelector('.stream-video-wrap').addEventListener('dblclick', () => focusStream(key));

  return { key, participant, publication, track, card, video, isLocal };
}

function addStream(participant, track, publication, isLocal = false) {
  if (!track || track.kind !== Track.Kind.Video) return;
  if (publication.source !== Track.Source.ScreenShare) return;

  const key = streamKey(participant, publication);
  const existing = state.streams.get(key);
  if (existing?.track === track) return;
  if (existing) removeStream(key);

  const entry = makeStreamCard(key, participant, track, publication, isLocal);
  state.streams.set(key, entry);
  els.streamGrid.appendChild(entry.card);
  updateShellUi();
}

function removeStream(key) {
  const entry = state.streams.get(key);
  if (!entry) return;
  try { entry.track.detach(entry.video); } catch {}
  entry.card.remove();
  state.streams.delete(key);

  if (state.focusedKey === key) {
    state.focusedKey = null;
    els.focusMount.replaceChildren();
  }
  updateShellUi();
}

function removeStreamsForParticipant(participant) {
  for (const [key, entry] of [...state.streams]) {
    if (entry.participant.identity === participant.identity) removeStream(key);
  }
  removeAudioForParticipant(participant);
}

function focusStream(key) {
  const entry = state.streams.get(key);
  if (!entry) return;
  state.focusedKey = key;
  els.focusMount.replaceChildren(entry.card);
  entry.card.classList.add('focused-card');
  renderStreamLayout();
}

function returnToGrid() {
  const entry = state.streams.get(state.focusedKey);
  if (entry) {
    entry.card.classList.remove('focused-card');
    els.streamGrid.appendChild(entry.card);
  }
  state.focusedKey = null;
  els.focusMount.replaceChildren();
  renderStreamLayout();
}

function addRemoteAudio(participant, track, publication) {
  const key = `${participant.identity}:${publication.trackSid || 'audio'}`;
  removeAudio(key);
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.playsInline = true;
  audio.hidden = true;
  document.body.appendChild(audio);
  track.attach(audio);
  state.audioTracks.set(key, { participant, track, audio });
  audio.play().catch(() => els.audioUnlock.classList.remove('hidden'));
}

function removeAudio(key) {
  const entry = state.audioTracks.get(key);
  if (!entry) return;
  try { entry.track.detach(entry.audio); } catch {}
  entry.audio.remove();
  state.audioTracks.delete(key);
}

function removeAudioForParticipant(participant) {
  for (const [key, entry] of [...state.audioTracks]) {
    if (entry.participant.identity === participant.identity) removeAudio(key);
  }
}

function resyncPublishedScreens() {
  if (!state.livekit) return;
  const participants = [state.livekit.localParticipant, ...state.livekit.remoteParticipants.values()];
  const liveKeys = new Set();

  for (const participant of participants) {
    for (const publication of participant.trackPublications.values()) {
      if (publication.source !== Track.Source.ScreenShare || publication.isMuted) continue;
      const key = streamKey(participant, publication);
      liveKeys.add(key);
      if (publication.track && !state.streams.has(key)) {
        addStream(participant, publication.track, publication, participant === state.livekit.localParticipant);
      }
    }
  }

  for (const key of [...state.streams.keys()]) {
    if (!liveKeys.has(key)) removeStream(key);
  }
  updateShellUi();
}

async function fetchJoinToken(roomId) {
  const response = await fetch('/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ room: roomId }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Could not enter the room.');
  return body;
}

function wireRoom(room) {
  room.on(RoomEvent.ParticipantConnected, () => {
    updateShellUi();
    toast('Someone joined.');
  });

  room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    removeStreamsForParticipant(participant);
    updateShellUi();
  });

  room.on(RoomEvent.TrackPublished, () => {
    queueMicrotask(resyncPublishedScreens);
  });

  room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    if (publication.source === Track.Source.ScreenShare && track.kind === Track.Kind.Video) {
      addStream(participant, track, publication, false);
      toast(`${participantLabel(participant)} started streaming.`);
    }
    if (publication.source === Track.Source.ScreenShareAudio && track.kind === Track.Kind.Audio) {
      addRemoteAudio(participant, track, publication);
    }
    resyncPublishedScreens();
  });

  room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
    if (publication.source === Track.Source.ScreenShare) removeStream(streamKey(participant, publication));
    if (publication.source === Track.Source.ScreenShareAudio) removeAudio(`${participant.identity}:${publication.trackSid || 'audio'}`);
    resyncPublishedScreens();
  });

  room.on(RoomEvent.TrackUnpublished, (publication, participant) => {
    if (publication.source === Track.Source.ScreenShare) removeStream(streamKey(participant, publication));
    if (publication.source === Track.Source.ScreenShareAudio) removeAudio(`${participant.identity}:${publication.trackSid || 'audio'}`);
    resyncPublishedScreens();
  });

  room.on(RoomEvent.LocalTrackPublished, (publication, participant) => {
    if (publication.source === Track.Source.ScreenShare && publication.track) {
      addStream(participant, publication.track, publication, true);
    }
    resyncPublishedScreens();
  });

  room.on(RoomEvent.LocalTrackUnpublished, (publication, participant) => {
    if (publication.source === Track.Source.ScreenShare) removeStream(streamKey(participant, publication));
    resyncPublishedScreens();
  });

  room.on(RoomEvent.TrackMuted, () => resyncPublishedScreens());
  room.on(RoomEvent.TrackUnmuted, () => resyncPublishedScreens());

  room.on(RoomEvent.Reconnecting, () => setStatus('Reconnecting…', 'reconnecting'));
  room.on(RoomEvent.Reconnected, () => {
    resyncPublishedScreens();
    toast('Connection restored.');
  });

  room.on(RoomEvent.Disconnected, () => {
    if (!state.livekit) return;
    setStatus('Disconnected');
  });
}

async function connectRoom(roomId) {
  const auth = await fetchJoinToken(roomId);
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    disconnectOnPageLeave: true,
    publishDefaults: {
      videoCodec: 'vp8',
      simulcast: true,
      screenShareEncoding: {
        maxBitrate: 2_500_000,
        maxFramerate: 30,
      },
      screenShareSimulcastLayers: [
        {
          width: 640,
          height: 360,
          encoding: { maxBitrate: 700_000, maxFramerate: 20 },
        },
      ],
    },
  });

  state.livekit = room;
  state.identity = auth.identity;
  wireRoom(room);
  await room.connect(auth.url, auth.token, { autoSubscribe: true });
  resyncPublishedScreens();
  startStatsLoop();
}

async function capScreenTrack(track) {
  const mediaTrack = track?.mediaStreamTrack;
  if (!mediaTrack?.applyConstraints) return;
  try {
    await mediaTrack.applyConstraints({
      width: { max: 1280 },
      height: { max: 720 },
      frameRate: { max: 30 },
    });
  } catch (error) {
    console.debug('Display constraints were not applied by this browser.', error);
  }
}

async function startSharing() {
  if (!state.livekit || isLocalSharing()) return;
  try {
    setStatus('Choose what to share…', 'sharing');
    await state.livekit.localParticipant.setScreenShareEnabled(true, { audio: true });
    const publication = state.livekit.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    if (!publication?.track) {
      updateShellUi();
      return;
    }
    await capScreenTrack(publication.track);
    addStream(state.livekit.localParticipant, publication.track, publication, true);
    updateShellUi();
  } catch (error) {
    console.error(error);
    updateShellUi();
    if (error?.name !== 'NotAllowedError') toast('Could not start screen sharing.');
  }
}

async function stopSharing() {
  if (!state.livekit || !isLocalSharing()) return;
  try {
    await state.livekit.localParticipant.setScreenShareEnabled(false);
  } catch (error) {
    console.error(error);
  }
  resyncPublishedScreens();
}

function startStatsLoop() {
  clearInterval(state.statsTimer);
  state.statsTimer = setInterval(() => {
    for (const entry of state.streams.values()) {
      const badge = entry.card.querySelector('.stream-network');
      const bitrate = Number(entry.track.currentBitrate || 0);
      if (bitrate > 0) {
        badge.textContent = bitrate >= 1_000_000 ? `${(bitrate / 1_000_000).toFixed(1)} Mbps` : `${Math.round(bitrate / 1000)} kbps`;
      } else {
        badge.textContent = 'Live';
      }
    }
  }, 2000);
}

async function leaveRoom() {
  clearInterval(state.statsTimer);
  try {
    if (isLocalSharing()) await state.livekit.localParticipant.setScreenShareEnabled(false);
    await state.livekit?.disconnect();
  } catch {}

  for (const key of [...state.streams.keys()]) removeStream(key);
  for (const key of [...state.audioTracks.keys()]) removeAudio(key);
  state.livekit = null;
  state.focusedKey = null;
  els.emptyState.classList.add('hidden');
  els.streamGrid.classList.add('hidden');
  els.focusView.classList.add('hidden');
  els.endedPanel.classList.remove('hidden');
  setStatus('Room left');
}

async function enterRoom(roomId) {
  state.roomId = roomId;
  show('room');
  els.endedPanel.classList.add('hidden');
  els.emptyState.classList.remove('hidden');

  const inviteUrl = new URL(location.origin);
  inviteUrl.searchParams.set('room', roomId);
  els.inviteLink.value = inviteUrl.toString();
  history.replaceState({}, '', `${location.pathname}?room=${encodeURIComponent(roomId)}`);

  setStatus('Connecting…');
  try {
    await connectRoom(roomId);
  } catch (error) {
    console.error(error);
    setStatus('Connection error');
    toast(error.message || 'Could not connect to the room.');
  }
}

els.createRoom.addEventListener('click', () => enterRoom(makeRoomId()));
els.shareScreen.addEventListener('click', startSharing);
els.emptyShareButton.addEventListener('click', startSharing);
els.stopSharing.addEventListener('click', stopSharing);
els.backToGrid.addEventListener('click', returnToGrid);

els.copyInvite.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.inviteLink.value);
    toast('Invite link copied.');
  } catch {
    els.inviteLink.select();
    document.execCommand('copy');
    toast('Invite link copied.');
  }
});

els.audioUnlock.addEventListener('click', async () => {
  try { await state.livekit?.startAudio(); } catch {}
  for (const entry of state.audioTracks.values()) await entry.audio.play().catch(() => {});
  els.audioUnlock.classList.add('hidden');
});

els.leaveRoom.addEventListener('click', async () => {
  await leaveRoom();
  history.replaceState({}, '', location.pathname);
});

const params = new URLSearchParams(location.search);
const roomId = params.get('room');
if (roomId && /^[a-zA-Z0-9_-]{20,80}$/.test(roomId)) enterRoom(roomId);
