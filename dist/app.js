const { Room, RoomEvent, Track } = window.LivekitClient;

const els = {
  home: document.querySelector('#home'),
  room: document.querySelector('#room'),
  createRoom: document.querySelector('#createRoom'),
  leaveRoom: document.querySelector('#leaveRoom'),
  statusPill: document.querySelector('#statusPill'),
  statusText: document.querySelector('#statusPill b'),
  lobbyPanel: document.querySelector('#lobbyPanel'),
  videoStage: document.querySelector('#videoStage'),
  endedPanel: document.querySelector('#endedPanel'),
  inviteLink: document.querySelector('#inviteLink'),
  copyInvite: document.querySelector('#copyInvite'),
  shareScreen: document.querySelector('#shareScreen'),
  screenVideo: document.querySelector('#screenVideo'),
  playScreen: document.querySelector('#playScreen'),
  sharingControls: document.querySelector('#sharingControls'),
  stopSharing: document.querySelector('#stopSharing'),
  fullscreenButton: document.querySelector('#fullscreenButton'),
  participantText: document.querySelector('#participantText'),
  viewerCount: document.querySelector('#viewerCount'),
  videoLabel: document.querySelector('#videoLabel'),
  toast: document.querySelector('#toast'),
};

const state = {
  roomId: null,
  livekit: null,
  participantCount: 1,
  remoteSharer: null,
  remoteVideoTrack: null,
  remoteAudioTrack: null,
  remoteAudioEl: null,
};

function show(view) {
  els.home.classList.toggle('active', view === 'home');
  els.room.classList.toggle('active', view === 'room');
}

function panel(name) {
  for (const el of [els.lobbyPanel, els.videoStage, els.endedPanel]) el.classList.add('hidden');
  els[name].classList.remove('hidden');
}

function setStatus(text, mode = '') {
  els.statusText.textContent = text;
  els.statusPill.classList.remove('connected', 'sharing');
  if (mode) els.statusPill.classList.add(mode);
}

function toast(text) {
  els.toast.textContent = text;
  els.toast.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.remove('show'), 2400);
}

function makeRoomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function isLocalSharing() {
  return Boolean(state.livekit?.localParticipant?.isScreenShareEnabled);
}

function findRemoteSharer() {
  if (!state.livekit) return null;
  for (const participant of state.livekit.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      if (publication.source === Track.Source.ScreenShare && !publication.isMuted) return participant;
    }
  }
  return null;
}

function updateRoomUi() {
  state.participantCount = state.livekit ? state.livekit.remoteParticipants.size + 1 : 1;
  state.remoteSharer = findRemoteSharer();
  const count = state.participantCount;
  const sharing = isLocalSharing();
  const someoneElseSharing = Boolean(state.remoteSharer);

  els.viewerCount.textContent = `${count} ${count === 1 ? 'person' : 'people'} in room`;
  els.participantText.textContent = count === 1 ? 'You’re the only person here.' : `${count} people are here.`;

  els.shareScreen.disabled = sharing || someoneElseSharing;
  els.shareScreen.classList.toggle('disabled', sharing || someoneElseSharing);

  if (sharing) {
    setStatus(`You’re sharing · ${count} ${count === 1 ? 'person' : 'people'}`, 'sharing');
  } else if (someoneElseSharing) {
    setStatus(`Watching screen · ${count} ${count === 1 ? 'person' : 'people'}`, 'sharing');
  } else {
    setStatus(count === 1 ? 'Room ready' : `${count} people connected`, count > 1 ? 'connected' : '');
    if (!els.videoStage.classList.contains('hidden')) clearRemoteScreen();
    panel('lobbyPanel');
  }
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

function clearRemoteScreen() {
  if (state.remoteVideoTrack) {
    try { state.remoteVideoTrack.detach(els.screenVideo); } catch {}
  }
  if (state.remoteAudioTrack && state.remoteAudioEl) {
    try { state.remoteAudioTrack.detach(state.remoteAudioEl); } catch {}
  }
  state.remoteVideoTrack = null;
  state.remoteAudioTrack = null;
  state.remoteAudioEl?.remove();
  state.remoteAudioEl = null;
  els.screenVideo.pause();
  els.screenVideo.srcObject = null;
  els.playScreen.classList.add('hidden');
}

async function attachRemoteVideo(track) {
  if (state.remoteVideoTrack && state.remoteVideoTrack !== track) {
    try { state.remoteVideoTrack.detach(els.screenVideo); } catch {}
  }
  state.remoteVideoTrack = track;
  track.attach(els.screenVideo);
  els.screenVideo.muted = true;
  els.videoLabel.textContent = 'SCREEN LIVE';
  els.sharingControls.classList.add('hidden');
  panel('videoStage');
  try {
    await els.screenVideo.play();
    els.playScreen.classList.add('hidden');
  } catch {
    els.playScreen.textContent = 'Click to watch';
    els.playScreen.classList.remove('hidden');
  }
}

async function attachRemoteAudio(track) {
  state.remoteAudioTrack = track;
  state.remoteAudioEl?.remove();
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.playsInline = true;
  audio.style.display = 'none';
  document.body.appendChild(audio);
  state.remoteAudioEl = audio;
  track.attach(audio);
  try {
    await audio.play();
  } catch {
    els.playScreen.textContent = 'Enable shared audio';
    els.playScreen.classList.remove('hidden');
  }
}

function wireRoom(room) {
  room.on(RoomEvent.ParticipantConnected, () => {
    updateRoomUi();
    toast('Someone joined the room.');
  });

  room.on(RoomEvent.ParticipantDisconnected, () => {
    updateRoomUi();
    toast('Someone left the room.');
  });

  room.on(RoomEvent.TrackSubscribed, async (track, publication, participant) => {
    if (publication.source === Track.Source.ScreenShare && track.kind === Track.Kind.Video) {
      state.remoteSharer = participant;
      await attachRemoteVideo(track);
    }
    if (publication.source === Track.Source.ScreenShareAudio && track.kind === Track.Kind.Audio) {
      await attachRemoteAudio(track);
    }
    updateRoomUi();
  });

  room.on(RoomEvent.TrackUnsubscribed, (track, publication) => {
    if (publication.source === Track.Source.ScreenShare && track === state.remoteVideoTrack) {
      clearRemoteScreen();
    }
    if (publication.source === Track.Source.ScreenShareAudio && track === state.remoteAudioTrack) {
      state.remoteAudioEl?.remove();
      state.remoteAudioEl = null;
      state.remoteAudioTrack = null;
    }
    updateRoomUi();
  });

  room.on(RoomEvent.TrackMuted, (_publication, participant) => {
    if (participant !== room.localParticipant) updateRoomUi();
  });
  room.on(RoomEvent.TrackUnmuted, (_publication, participant) => {
    if (participant !== room.localParticipant) updateRoomUi();
  });

  room.on(RoomEvent.Disconnected, () => {
    if (!els.endedPanel.classList.contains('hidden')) return;
    setStatus('Disconnected');
    toast('Room connection closed.');
  });
}

async function connectRoom(roomId) {
  const auth = await fetchJoinToken(roomId);
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    disconnectOnPageLeave: true,
  });
  state.livekit = room;
  wireRoom(room);
  await room.connect(auth.url, auth.token, { autoSubscribe: true });
  updateRoomUi();
}

async function startSharing() {
  if (!state.livekit) return;
  if (findRemoteSharer()) {
    toast('Someone is already sharing their screen.');
    updateRoomUi();
    return;
  }

  try {
    setStatus('Choose a screen to share…', 'sharing');
    await state.livekit.localParticipant.setScreenShareEnabled(true, { audio: true });

    if (!state.livekit.localParticipant.isScreenShareEnabled) {
      updateRoomUi();
      return;
    }

    const publication = state.livekit.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    const localTrack = publication?.track;
    if (localTrack) {
      localTrack.attach(els.screenVideo);
      els.screenVideo.muted = true;
      await els.screenVideo.play().catch(() => {});
    }

    els.videoLabel.textContent = 'YOU ARE LIVE';
    els.sharingControls.classList.remove('hidden');
    els.playScreen.classList.add('hidden');
    panel('videoStage');
    updateRoomUi();
  } catch (error) {
    console.error(error);
    updateRoomUi();
    if (error?.name !== 'NotAllowedError') toast('Could not start screen sharing.');
  }
}

async function stopSharing() {
  if (!state.livekit) return;
  try {
    await state.livekit.localParticipant.setScreenShareEnabled(false);
  } catch (error) {
    console.error(error);
  }
  els.screenVideo.pause();
  els.screenVideo.srcObject = null;
  els.sharingControls.classList.add('hidden');
  panel('lobbyPanel');
  updateRoomUi();
}

async function leaveRoom() {
  try {
    if (isLocalSharing()) await state.livekit.localParticipant.setScreenShareEnabled(false);
    clearRemoteScreen();
    await state.livekit?.disconnect();
  } catch {}
  state.livekit = null;
  panel('endedPanel');
  setStatus('Room left');
}

async function enterRoom(roomId) {
  state.roomId = roomId;
  show('room');
  panel('lobbyPanel');

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
els.copyInvite.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.inviteLink.value);
    els.copyInvite.textContent = 'Copied';
    toast('Invite link copied.');
    setTimeout(() => { els.copyInvite.textContent = 'Copy link'; }, 1600);
  } catch {
    els.inviteLink.select();
    document.execCommand('copy');
    toast('Invite link copied.');
  }
});
els.shareScreen.addEventListener('click', startSharing);
els.stopSharing.addEventListener('click', stopSharing);
els.playScreen.addEventListener('click', async () => {
  try {
    await els.screenVideo.play();
    if (state.remoteAudioEl) await state.remoteAudioEl.play();
    els.playScreen.classList.add('hidden');
  } catch {
    toast('Playback is still blocked by this browser.');
  }
});
els.leaveRoom.addEventListener('click', async () => {
  await leaveRoom();
  history.replaceState({}, '', location.pathname);
});
els.fullscreenButton.addEventListener('click', async () => {
  if (!document.fullscreenElement) await els.videoStage.requestFullscreen?.();
  else await document.exitFullscreen?.();
});

const params = new URLSearchParams(location.search);
const roomId = params.get('room');
if (roomId && /^[a-zA-Z0-9_-]{20,80}$/.test(roomId)) enterRoom(roomId);
