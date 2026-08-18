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
  clientId: null,
  socket: null,
  peers: new Map(),
  stream: null,
  participantCount: 1,
  activeSharer: null,
  pendingShareStream: null,
};

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
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
  toast.timer = setTimeout(() => els.toast.classList.remove('show'), 2000);
}

function makeRoomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function wsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/api/ws`;
}

function send(type, payload = {}) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ type, ...payload }));
  }
}

function sendSignal(target, data) {
  send('signal', { target, data });
}

function updateRoomUi() {
  const count = state.participantCount;
  els.viewerCount.textContent = `${count} ${count === 1 ? 'person' : 'people'} in room`;

  if (count === 1) els.participantText.textContent = 'You’re the only person here.';
  else els.participantText.textContent = `${count} people are here.`;

  if (!state.activeSharer) {
    setStatus(count === 1 ? 'Room ready' : `${count} people connected`, count > 1 ? 'connected' : '');
    els.shareScreen.disabled = false;
    els.shareScreen.classList.remove('disabled');
  } else if (state.activeSharer === state.clientId) {
    setStatus(`You’re sharing · ${count} ${count === 1 ? 'person' : 'people'}`, 'sharing');
  } else {
    setStatus(`Watching screen · ${count} ${count === 1 ? 'person' : 'people'}`, 'sharing');
    els.shareScreen.disabled = true;
    els.shareScreen.classList.add('disabled');
  }
}

function connectSocket() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl());
    state.socket = socket;
    const timeout = setTimeout(() => reject(new Error('Connection timed out.')), 10000);

    socket.addEventListener('open', () => {
      clearTimeout(timeout);
      send('join', { roomId: state.roomId });
      resolve();
    }, { once: true });

    socket.addEventListener('message', onSocketMessage);
    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      setStatus('Connection error');
      toast('Could not connect to the room.');
    });
  });
}

async function onSocketMessage(event) {
  const message = JSON.parse(event.data);

  if (message.type === 'joined') {
    state.clientId = message.clientId;
    state.participantCount = message.participantCount;
    state.activeSharer = message.activeSharer;

    for (const peerId of message.peers) {
      getPeer(peerId, false);
    }

    updateRoomUi();
    if (!state.activeSharer) panel('lobbyPanel');
    return;
  }

  if (message.type === 'participant-joined') {
    state.participantCount = message.participantCount;
    getPeer(message.clientId, true);
    updateRoomUi();
    toast('Someone joined the room.');
    return;
  }

  if (message.type === 'participant-left') {
    state.participantCount = message.participantCount;
    closePeer(message.clientId);
    updateRoomUi();
    toast('Someone left the room.');
    return;
  }

  if (message.type === 'sharing-state') {
    const previousSharer = state.activeSharer;
    state.activeSharer = message.activeSharer;
    state.participantCount = message.participantCount;

    if (!state.activeSharer) {
      if (previousSharer !== state.clientId) {
        els.screenVideo.srcObject = null;
        panel('lobbyPanel');
      }
      els.sharingControls.classList.add('hidden');
      updateRoomUi();
      return;
    }

    if (state.activeSharer === state.clientId) {
      state.stream = state.pendingShareStream || state.stream;
      state.pendingShareStream = null;
      if (!state.stream) return;
      els.screenVideo.srcObject = state.stream;
      els.videoLabel.textContent = 'YOU ARE LIVE';
      els.sharingControls.classList.remove('hidden');
      panel('videoStage');
      await publishStreamToAll();
    } else {
      els.videoLabel.textContent = 'SCREEN LIVE';
      els.sharingControls.classList.add('hidden');
      panel('videoStage');
    }

    updateRoomUi();
    return;
  }

  if (message.type === 'share-denied') {
    stopPendingShare();
    state.activeSharer = message.activeSharer;
    toast(message.message || 'Someone is already sharing.');
    updateRoomUi();
    return;
  }

  if (message.type === 'signal') {
    await handleSignal(message.from, message.data);
    return;
  }

  if (message.type === 'error') {
    toast(message.message || 'Room error.');
  }
}

function getPeer(peerId, initiator) {
  if (state.peers.has(peerId)) return state.peers.get(peerId).peer;

  const peer = new RTCPeerConnection(rtcConfig);
  const entry = { peer, candidateQueue: [], makingOffer: false };
  state.peers.set(peerId, entry);

  peer.onicecandidate = (event) => {
    if (event.candidate) sendSignal(peerId, { candidate: event.candidate });
  };

  peer.ontrack = (event) => {
    if (state.activeSharer && state.activeSharer !== peerId) return;
    const [stream] = event.streams;
    if (!stream) return;
    els.screenVideo.srcObject = stream;
    els.videoLabel.textContent = 'SCREEN LIVE';
    els.sharingControls.classList.add('hidden');
    panel('videoStage');
    setStatus(`Watching screen · ${state.participantCount} people`, 'sharing');
  };

  peer.onconnectionstatechange = () => {
    if (['failed', 'closed'].includes(peer.connectionState)) closePeer(peerId);
  };

  if (state.stream && state.activeSharer === state.clientId) {
    for (const track of state.stream.getTracks()) peer.addTrack(track, state.stream);
  }

  if (initiator) createOffer(peerId).catch(() => {});
  return peer;
}

async function createOffer(peerId) {
  const entry = state.peers.get(peerId);
  if (!entry || entry.makingOffer) return;
  entry.makingOffer = true;
  try {
    const offer = await entry.peer.createOffer();
    await entry.peer.setLocalDescription(offer);
    sendSignal(peerId, { description: entry.peer.localDescription });
  } finally {
    entry.makingOffer = false;
  }
}

async function handleSignal(from, data) {
  const peer = getPeer(from, false);
  const entry = state.peers.get(from);

  if (data.description) {
    await peer.setRemoteDescription(data.description);
    while (entry.candidateQueue.length) {
      await peer.addIceCandidate(entry.candidateQueue.shift()).catch(() => {});
    }

    if (data.description.type === 'offer') {
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      sendSignal(from, { description: peer.localDescription });
    }
    return;
  }

  if (data.candidate) {
    if (peer.remoteDescription) await peer.addIceCandidate(data.candidate).catch(() => {});
    else entry.candidateQueue.push(data.candidate);
  }
}

async function publishStreamToAll() {
  if (!state.stream) return;

  for (const [peerId, entry] of state.peers) {
    const peer = entry.peer;
    const existingSenders = peer.getSenders();
    const streamTracks = state.stream.getTracks();

    for (const track of streamTracks) {
      const sender = existingSenders.find((item) => item.track?.kind === track.kind);
      if (sender) await sender.replaceTrack(track);
      else peer.addTrack(track, state.stream);
    }

    await createOffer(peerId).catch(() => {});
  }
}

function closePeer(peerId) {
  const entry = state.peers.get(peerId);
  if (!entry) return;
  entry.peer.ontrack = null;
  entry.peer.onicecandidate = null;
  entry.peer.close();
  state.peers.delete(peerId);
}

function closeAllPeers() {
  for (const peerId of [...state.peers.keys()]) closePeer(peerId);
}

async function startSharing() {
  if (state.activeSharer && state.activeSharer !== state.clientId) {
    toast('Someone is already sharing their screen.');
    return;
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast('Screen sharing is not supported in this browser.');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: true,
    });
    state.pendingShareStream = stream;
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) videoTrack.addEventListener('ended', stopSharing, { once: true });
    send('start-sharing');
    setStatus('Starting screen share…', 'sharing');
  } catch (error) {
    if (error?.name !== 'NotAllowedError') toast('Could not start screen sharing.');
  }
}

function stopPendingShare() {
  if (!state.pendingShareStream) return;
  state.pendingShareStream.getTracks().forEach((track) => track.stop());
  state.pendingShareStream = null;
}

function stopSharing() {
  stopPendingShare();
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }

  for (const { peer } of state.peers.values()) {
    for (const sender of peer.getSenders()) {
      if (sender.track) sender.replaceTrack(null).catch(() => {});
    }
  }

  els.screenVideo.srcObject = null;
  els.sharingControls.classList.add('hidden');
  if (state.activeSharer === state.clientId) send('stop-sharing');
  state.activeSharer = null;
  panel('lobbyPanel');
  updateRoomUi();
}

function leaveRoom() {
  stopPendingShare();
  if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
  state.stream = null;
  closeAllPeers();
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.close(1000, 'Left room');
  state.socket = null;
  panel('endedPanel');
  setStatus('Room left');
}

async function enterRoom(roomId) {
  state.roomId = roomId;
  state.activeSharer = null;
  state.participantCount = 1;
  show('room');
  panel('lobbyPanel');

  const inviteUrl = new URL(location.origin);
  inviteUrl.searchParams.set('room', roomId);
  els.inviteLink.value = inviteUrl.toString();
  history.replaceState({}, '', `${location.pathname}?room=${encodeURIComponent(roomId)}`);

  setStatus('Connecting…');
  try {
    await connectSocket();
  } catch {
    setStatus('Connection error');
    toast('Could not connect to signaling.');
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
els.leaveRoom.addEventListener('click', () => {
  leaveRoom();
  history.replaceState({}, '', location.pathname);
});
els.fullscreenButton.addEventListener('click', async () => {
  if (!document.fullscreenElement) await els.videoStage.requestFullscreen?.();
  else await document.exitFullscreen?.();
});
window.addEventListener('beforeunload', () => {
  state.socket?.close(1000, 'Page closed');
  state.stream?.getTracks().forEach((track) => track.stop());
  state.pendingShareStream?.getTracks().forEach((track) => track.stop());
});

const params = new URLSearchParams(location.search);
const roomId = params.get('room');
if (roomId && /^[a-zA-Z0-9_-]{20,80}$/.test(roomId)) enterRoom(roomId);
