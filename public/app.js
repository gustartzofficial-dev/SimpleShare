const $ = (s) => document.querySelector(s);
const els = {
  home: $('#home'), room: $('#room'), createRoom: $('#createRoom'), leaveRoom: $('#leaveRoom'),
  statusPill: $('#statusPill'), statusText: $('#statusPill b'), participantCount: $('#participantCount'), modeBadge: $('#modeBadge'),
  peopleCount: $('#peopleCount'), peopleList: $('#peopleList'), shareScreen: $('#shareScreen'), stopSharing: $('#stopSharing'),
  emptyShareButton: $('#emptyShareButton'), shareQuality: $('#shareQuality'), includeAudio: $('#includeAudio'), qualityHint: $('#qualityHint'),
  inviteLink: $('#inviteLink'), copyInvite: $('#copyInvite'), emptyState: $('#emptyState'), streamGrid: $('#streamGrid'),
  focusView: $('#focusView'), focusMount: $('#focusMount'), backToGrid: $('#backToGrid'), fullscreenFocus: $('#fullscreenFocus'),
  connectionBanner: $('#connectionBanner'), audioUnlock: $('#audioUnlock'), toast: $('#toast'), setupError: $('#setupError'),
  setupErrorTitle: $('#setupErrorTitle'), setupErrorText: $('#setupErrorText'), template: $('#streamCardTemplate'),
};

const PROFILES = {
  '720p30': { label:'720p · 30', width:1280, height:720, fps:30, bitrate:1_800_000, low:320_000, hint:'Balanced quality and bandwidth' },
  '720p60': { label:'720p · 60', width:1280, height:720, fps:60, bitrate:3_000_000, low:450_000, hint:'Smoother motion, more bandwidth' },
  '1080p60': { label:'1080p · 60', width:1920, height:1080, fps:60, bitrate:5_500_000, low:450_000, medium:2_100_000, hint:'Maximum clarity and motion' },
};

const state = {
  apiBase:'', roomId:'', mode:'cloud', participantId:'', token:'', ws:null, manualLeave:false, joined:false,
  participants:new Map(), announcements:new Map(), cards:new Map(), cloudSubs:new Map(), directPeers:new Map(),
  localShare:null, focusedId:null, audioUnlocked:false, reconnectTimer:null, heartbeat:null, statsTimer:null,
  suspended:false,
};

function show(view) { els.home.classList.toggle('active', view === 'home'); els.room.classList.toggle('active', view === 'room'); }
function toast(text) { els.toast.textContent = text; els.toast.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => els.toast.classList.remove('show'), 2200); }
function setStatus(text, mode='') { els.statusText.textContent = text; els.statusPill.classList.remove('connected','sharing','reconnecting'); if (mode) els.statusPill.classList.add(mode); }
function uid(bytes=18) { const b = crypto.getRandomValues(new Uint8Array(bytes)); return btoa(String.fromCharCode(...b)).replaceAll('+','-').replaceAll('/','_').replaceAll('=',''); }
function randomName() { return `Guest ${uid(3).slice(0,4).toUpperCase()}`; }
function myName() { let n = localStorage.getItem('simpleshare-name'); if (!n) { n = randomName(); localStorage.setItem('simpleshare-name', n); } return n; }
function initial(name) { return String(name || '?').replace(/^Guest\s+/i,'').slice(0,2).toUpperCase(); }
function profile(id) { return PROFILES[id] || PROFILES['720p30']; }
function normalizeApiBase(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}
function wsUrl(base, path) { return `${base.replace(/^http/i, 'ws')}${path}`; }
function setRoomControlsEnabled(enabled) {
  els.shareScreen.disabled = !enabled;
  els.emptyShareButton.disabled = !enabled;
  els.shareQuality.disabled = !enabled || Boolean(state.localShare);
  els.includeAudio.disabled = !enabled || Boolean(state.localShare);
}
function showSetupFailure(title, message) {
  if (els.setupErrorTitle) els.setupErrorTitle.textContent = title;
  if (els.setupErrorText) els.setupErrorText.textContent = message;
  els.setupError.classList.remove('hidden');
  setRoomControlsEnabled(false);
}
function authEnvelope(extra={}) { return { room:state.roomId, participantId:state.participantId, token:state.token, ...extra }; }

async function api(path, { method='GET', body=null }={}) {
  if (!state.apiBase) throw new Error('ROOM_API_URL is missing.');
  let response;
  try {
    response = await fetch(`${state.apiBase}${path}`, {
      method,
      headers: body ? { 'content-type':'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    throw new Error(`Could not reach room server (${state.apiBase}). ${error?.message || ''}`.trim());
  }
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { error:raw }; }
  if (!response.ok) {
    const detail = data.error || data.errorDescription || raw || response.statusText || 'Request failed';
    throw new Error(`${detail} [${response.status}]`);
  }
  return data;
}

async function sfu(path, method='POST', payload={}) {
  return api(`/api/sfu${path}`, { method, body:authEnvelope(payload) });
}

function sendWs(payload) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(payload));
}

function makePeerConnection() {
  return new RTCPeerConnection({
    iceServers:[{ urls:'stun:stun.cloudflare.com:3478' }],
    bundlePolicy:'max-bundle',
  });
}

function waitForConnected(pc, timeout=12000) {
  if (['connected','completed'].includes(pc.iceConnectionState)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Media connection timed out.')); }, timeout);
    const onChange = () => {
      if (['connected','completed'].includes(pc.iceConnectionState)) { cleanup(); resolve(); }
      else if (['failed','closed'].includes(pc.iceConnectionState)) { cleanup(); reject(new Error(`Media connection ${pc.iceConnectionState}.`)); }
    };
    const cleanup = () => { clearTimeout(timer); pc.removeEventListener('iceconnectionstatechange', onChange); };
    pc.addEventListener('iceconnectionstatechange', onChange);
  });
}

function renderPeople() {
  els.peopleList.replaceChildren();
  const streamsByOwner = new Set([...state.announcements.values()].map(s => s.ownerId));
  const people = [...state.participants.values()].sort((a,b) => a.joinedAt - b.joinedAt);
  for (const p of people) {
    const row = document.createElement('div'); row.className = 'person-row';
    const name = p.id === state.participantId ? `${p.name} (you)` : p.name;
    row.innerHTML = `<span class="person-avatar">${initial(p.name)}</span><span class="person-name"></span>${streamsByOwner.has(p.id) ? '<span class="person-live">LIVE</span>' : '<span class="person-dot"></span>'}`;
    row.querySelector('.person-name').textContent = name;
    els.peopleList.appendChild(row);
  }
  const count = people.length;
  els.peopleCount.textContent = String(count);
  els.participantCount.textContent = `${count} ${count === 1 ? 'person' : 'people'}`;
}

function renderShell() {
  const live = state.announcements.size;
  const sharing = Boolean(state.localShare);
  els.shareScreen.classList.toggle('hidden', sharing);
  els.stopSharing.classList.toggle('hidden', !sharing);
  els.shareQuality.disabled = sharing;
  els.includeAudio.disabled = sharing;
  els.modeBadge.textContent = state.mode === 'cloud' ? 'CLOUD' : 'DIRECT';
  if (sharing) setStatus(`You're live · ${live} ${live === 1 ? 'stream' : 'streams'}`, 'sharing');
  else if (live) setStatus(`${live} live ${live === 1 ? 'stream' : 'streams'}`, 'sharing');
  else setStatus('Room ready', 'connected');
  renderPeople();
  renderLayout();
}

function renderLayout() {
  const count = state.cards.size;
  const focused = state.focusedId && state.cards.has(state.focusedId);
  els.emptyState.classList.toggle('hidden', count > 0 || focused);
  els.streamGrid.classList.toggle('hidden', count === 0 || focused);
  els.focusView.classList.toggle('hidden', !focused);
  els.streamGrid.classList.toggle('one', count === 1);
  els.streamGrid.classList.toggle('two', count === 2);
  updateAudioButton();
}

function updateAudioButton() {
  const hasRemoteAudio = [...state.cards.values()].some(c => !c.local && c.media?.getAudioTracks().length);
  els.audioUnlock.classList.toggle('hidden', !hasRemoteAudio || state.audioUnlocked);
}

function attachMediaToCard(entry, media) {
  entry.media = media;
  entry.video.srcObject = media;
  entry.video.muted = entry.local || !state.audioUnlocked;
  entry.video.play().catch(() => {});
  entry.loading.classList.remove('hidden');
  const ready = () => entry.loading.classList.add('hidden');
  entry.video.addEventListener('playing', ready, { once:true });
  entry.video.addEventListener('loadeddata', ready, { once:true });
  updateAudioButton();
}

function cardTitle(ann) { return ann.ownerId === state.participantId ? 'Your stream' : `${ann.ownerName || 'Guest'}'s stream`; }

function createCard(ann, media, { local=false, statsPc=null }={}) {
  if (state.cards.has(ann.id)) {
    const existing = state.cards.get(ann.id);
    if (media) attachMediaToCard(existing, media);
    return existing;
  }
  const frag = els.template.content.cloneNode(true);
  const card = frag.querySelector('.stream-card');
  const video = frag.querySelector('video');
  const loading = frag.querySelector('.stream-loading');
  const qualitySelect = frag.querySelector('.viewer-quality');
  const entry = { id:ann.id, ann, card, video, loading, qualitySelect, local, statsPc, media:null, viewerQuality:'auto', lastBytes:0, lastAt:0 };
  card.dataset.streamId = ann.id;
  card.querySelector('.stream-avatar').textContent = initial(ann.ownerName);
  card.querySelector('.stream-copy strong').textContent = cardTitle(ann);
  card.querySelector('.stream-meta').textContent = `${profile(ann.profile).label} · ${ann.mode === 'cloud' ? 'Cloud edge' : 'Direct'}`;
  const expand = card.querySelector('.expand-stream');
  expand.addEventListener('click', () => focusStream(ann.id));
  card.querySelector('.stream-video-wrap').addEventListener('dblclick', () => focusStream(ann.id));

  if (local) qualitySelect.classList.add('hidden');
  else {
    if (ann.profile !== '1080p60') qualitySelect.querySelector('option[value="1080"]')?.remove();
    qualitySelect.addEventListener('change', () => setViewerQuality(ann.id, qualitySelect.value));
  }

  state.cards.set(ann.id, entry);
  if (!local && ann.mode === 'cloud' && 'ResizeObserver' in window) {
    const ro = new ResizeObserver(() => { if (entry.viewerQuality === 'auto') applyCloudViewerQuality(ann.id, 'auto').catch(() => {}); });
    ro.observe(card); entry.resizeObserver = ro;
  }
  els.streamGrid.appendChild(card);
  if (media) attachMediaToCard(entry, media);
  renderLayout();
  return entry;
}

async function removeCard(streamId) {
  const entry = state.cards.get(streamId);
  if (!entry) return;
  if (state.focusedId === streamId) await returnToGrid();
  try { entry.video.srcObject = null; } catch {}
  try { entry.resizeObserver?.disconnect(); } catch {}
  entry.card.remove();
  state.cards.delete(streamId);
  renderLayout();
}

async function focusStream(streamId) {
  const entry = state.cards.get(streamId); if (!entry) return;
  if (state.focusedId === streamId) return;
  state.focusedId = streamId;
  els.focusMount.replaceChildren(entry.card);
  if (state.mode === 'cloud') {
    for (const [id] of state.cloudSubs) if (id !== streamId) await suspendCloudSubscription(id);
    await applyCloudViewerQuality(streamId, 'auto');
  }
  renderLayout();
}

async function returnToGrid() {
  const id = state.focusedId;
  if (id) {
    const entry = state.cards.get(id);
    if (entry) els.streamGrid.appendChild(entry.card);
  }
  state.focusedId = null;
  els.focusMount.replaceChildren();
  if (state.mode === 'cloud' && !state.suspended) {
    for (const ann of state.announcements.values()) if (ann.ownerId !== state.participantId) ensureCloudSubscription(ann).catch(console.error);
  }
  renderLayout();
}

function updateQualityHint() { els.qualityHint.textContent = profile(els.shareQuality.value).hint; }

function streamEncodings(profileId) {
  const p = profile(profileId);
  if (profileId === '1080p60') return [
    { rid:'a', scaleResolutionDownBy:1, maxBitrate:p.bitrate, maxFramerate:60 },
    { rid:'m', scaleResolutionDownBy:1.5, maxBitrate:p.medium, maxFramerate:30 },
    { rid:'z', scaleResolutionDownBy:3, maxBitrate:p.low, maxFramerate:15 },
  ];
  return [
    { rid:'a', scaleResolutionDownBy:1, maxBitrate:p.bitrate, maxFramerate:p.fps },
    { rid:'z', scaleResolutionDownBy:2, maxBitrate:p.low, maxFramerate:15 },
  ];
}

async function getScreen() {
  const p = profile(els.shareQuality.value);
  return navigator.mediaDevices.getDisplayMedia({
    video:{ width:{ ideal:p.width, max:p.width }, height:{ ideal:p.height, max:p.height }, frameRate:{ ideal:p.fps, max:p.fps } },
    audio:els.includeAudio.checked,
  });
}

async function startSharing() {
  if (!state.joined || !state.participantId || !state.token || state.ws?.readyState !== WebSocket.OPEN) {
    toast('Room is not connected yet.');
    return;
  }
  if (state.localShare) return;
  try {
    els.shareScreen.disabled = true; els.emptyShareButton.disabled = true;
    const media = await getScreen();
    const video = media.getVideoTracks()[0];
    if (!video) throw new Error('No screen video track was selected.');
    const pId = els.shareQuality.value;
    video.contentHint = 'detail';
    video.addEventListener('ended', () => stopSharing().catch(console.error), { once:true });
    if (state.mode === 'cloud') await startCloudShare(media, pId);
    else await startDirectShare(media, pId);
  } catch (error) {
    if (error?.name !== 'NotAllowedError') toast(error?.message || 'Could not start sharing.');
  } finally {
    els.shareScreen.disabled = false; els.emptyShareButton.disabled = false;
    renderShell();
  }
}

async function startCloudShare(media, profileId) {
  const session = await sfu('/session', 'POST');
  const pc = makePeerConnection();
  const videoTrack = media.getVideoTracks()[0];
  const audioTrack = media.getAudioTracks()[0] || null;

  // Follow Cloudflare's maintained browser examples exactly: create the local
  // transceivers, create an offer, apply it locally, then POST that offer SDP
  // together with explicit local-track descriptors. This avoids relying on
  // autoDiscover / RTCSessionDescription serialization differences between
  // browsers.
  const videoTransceiver = pc.addTransceiver(videoTrack, {
    direction:'sendonly',
    sendEncodings:streamEncodings(profileId),
  });
  const audioTransceiver = audioTrack
    ? pc.addTransceiver(audioTrack, { direction:'sendonly' })
    : null;

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const videoMid = videoTransceiver.mid;
  const audioMid = audioTransceiver?.mid ?? null;
  if (videoMid == null) throw new Error('Browser did not assign a video MID for the Cloudflare session.');
  if (audioTrack && audioMid == null) throw new Error('Browser did not assign an audio MID for the Cloudflare session.');

  const videoTrackName = crypto.randomUUID();
  const audioTrackName = audioTrack ? crypto.randomUUID() : null;
  const tracks = [
    { location:'local', mid:String(videoMid), trackName:videoTrackName },
  ];
  if (audioTrack && audioMid != null) {
    tracks.push({ location:'local', mid:String(audioMid), trackName:audioTrackName });
  }

  const connected = waitForConnected(pc);
  const response = await sfu(`/sessions/${session.sessionId}/tracks/new`, 'POST', {
    sessionDescription: { type:'offer', sdp:offer.sdp },
    tracks,
  });
  if (response.errorCode) throw new Error(response.errorDescription || response.errorCode);
  if (!response.sessionDescription?.sdp) throw new Error('Cloudflare Realtime did not return an SDP answer.');
  await pc.setRemoteDescription(response.sessionDescription);
  await connected;

  const ann = {
    id:`${state.participantId}-${uid(5)}`, ownerId:state.participantId, ownerName:state.participants.get(state.participantId)?.name || myName(),
    mode:'cloud', sessionId:session.sessionId, videoTrackName, audioTrackName,
    profile:profileId, audio:Boolean(audioTrackName),
  };
  state.localShare = { ann, media, pc, sessionId:session.sessionId, profileId };
  state.announcements.set(ann.id, ann);
  createCard(ann, media, { local:true, statsPc:pc });
  sendWs({ type:'stream-upsert', stream:ann });
}

async function stopSharing() {
  const share = state.localShare; if (!share) return;
  state.localShare = null;
  sendWs({ type:'stream-remove', streamId:share.ann.id });
  state.announcements.delete(share.ann.id);
  if (share.ann.mode === 'direct') {
    for (const peer of state.directPeers.values()) {
      try { await peer.video.sender.replaceTrack(null); } catch {}
      try { await peer.audio.sender.replaceTrack(null); } catch {}
    }
  }
  share.media?.getTracks().forEach(t => t.stop());
  try { share.pc?.close(); } catch {}
  await removeCard(share.ann.id);
  renderShell();
}

async function createCloudSubscriptionSession() {
  return sfu('/session', 'POST');
}

function desiredRid(ann, choice='auto', card=null) {
  if (choice === '360') return 'z';
  if (choice === '720') return ann.profile === '1080p60' ? 'm' : 'a';
  if (choice === '1080') return 'a';
  if (state.focusedId === ann.id) return 'a';
  const width = card?.getBoundingClientRect().width || 700;
  if (width < 650 || state.cards.size >= 3) return 'z';
  if (ann.profile === '1080p60' && width < 1200) return 'm';
  return 'a';
}

async function pullCloudTracks(sub, ann) {
  const tracks = [{ location:'remote', sessionId:ann.sessionId, trackName:ann.videoTrackName }];
  if (ann.audioTrackName) tracks.push({ location:'remote', sessionId:ann.sessionId, trackName:ann.audioTrackName });
  let response;
  for (let i=0; i<5; i++) {
    response = await sfu(`/sessions/${sub.sessionId}/tracks/new`, 'POST', { tracks });
    const missing = response.errorCode === 'not_found_track_error' || response.tracks?.some(t => t.errorCode === 'not_found_track_error');
    if (!missing) break;
    await new Promise(r => setTimeout(r, [250,500,900,1500,2200][i]));
  }
  return response;
}

async function ensureCloudSubscription(ann) {
  if (state.suspended || ann.ownerId === state.participantId || state.cloudSubs.has(ann.id)) return;
  if (state.focusedId && state.focusedId !== ann.id) return;
  const session = await createCloudSubscriptionSession();
  const pc = makePeerConnection();
  const media = new MediaStream();
  const sub = { streamId:ann.id, ann, sessionId:session.sessionId, pc, media, videoMid:null, active:true };
  state.cloudSubs.set(ann.id, sub);
  pc.addEventListener('track', e => {
    media.addTrack(e.track);
    const card = createCard(ann, media, { local:false, statsPc:pc });
    attachMediaToCard(card, media);
  });
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed' && state.cloudSubs.get(ann.id) === sub) {
      suspendCloudSubscription(ann.id).then(() => ensureCloudSubscription(ann)).catch(console.error);
    }
  });

  try {
    const response = await pullCloudTracks(sub, ann);
    if (response.errorCode) throw new Error(response.errorDescription || response.errorCode);
    if (response.tracks?.some(t => t.errorCode)) throw new Error(response.tracks.find(t => t.errorCode).errorDescription || 'Track unavailable');
    const videoInfo = response.tracks?.find(t => t.trackName === ann.videoTrackName) || response.tracks?.find(t => t.mid);
    sub.videoMid = videoInfo?.mid || null;
    if (response.requiresImmediateRenegotiation) {
      await pc.setRemoteDescription(response.sessionDescription);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      const renegotiate = await sfu(`/sessions/${session.sessionId}/renegotiate`, 'PUT', { sessionDescription:{ type:'answer', sdp:answer.sdp } });
      if (renegotiate.errorCode) throw new Error(renegotiate.errorDescription || renegotiate.errorCode);
    }
    await waitForConnected(pc).catch(() => {});
    await applyCloudViewerQuality(ann.id, state.cards.get(ann.id)?.viewerQuality || 'auto');
  } catch (error) {
    if (state.cloudSubs.get(ann.id) === sub) state.cloudSubs.delete(ann.id);
    try { pc.close(); } catch {}
    const card = state.cards.get(ann.id);
    if (card) card.loading.querySelector('p').textContent = 'Stream unavailable — retrying…';
    setTimeout(() => ensureCloudSubscription(ann).catch(console.error), 1800);
  }
}

async function suspendCloudSubscription(streamId) {
  const sub = state.cloudSubs.get(streamId); if (!sub) return;
  state.cloudSubs.delete(streamId);
  sub.active = false;
  try { sub.pc.close(); } catch {}
  const card = state.cards.get(streamId);
  if (card) {
    card.video.srcObject = null;
    card.loading.classList.remove('hidden');
    card.loading.querySelector('p').textContent = 'Paused to save bandwidth';
  }
}

async function applyCloudViewerQuality(streamId, choice) {
  const sub = state.cloudSubs.get(streamId); const card = state.cards.get(streamId);
  if (!sub || !sub.videoMid) return;
  const ann = sub.ann;
  const rid = desiredRid(ann, choice, card?.card);
  const track = {
    location:'remote', sessionId:ann.sessionId, trackName:ann.videoTrackName, mid:sub.videoMid,
    simulcast:{ preferredRid:rid, priorityOrdering:'asciibetical', ridNotAvailable:'asciibetical' },
  };
  await sfu(`/sessions/${sub.sessionId}/tracks/update`, 'PUT', { tracks:[track] }).catch(() => {});
}

async function setViewerQuality(streamId, choice) {
  const entry = state.cards.get(streamId); const ann = state.announcements.get(streamId); if (!entry || !ann) return;
  entry.viewerQuality = choice;
  if (state.mode === 'cloud') await applyCloudViewerQuality(streamId, choice);
  else sendWs({ type:'quality-request', target:ann.ownerId, quality:choice });
}

async function startDirectShare(media, profileId) {
  const ann = {
    id:`${state.participantId}-${uid(5)}`, ownerId:state.participantId, ownerName:state.participants.get(state.participantId)?.name || myName(),
    mode:'direct', sessionId:null, videoTrackName:null, audioTrackName:null, profile:profileId, audio:Boolean(media.getAudioTracks()[0]),
  };
  state.localShare = { ann, media, profileId, pc:null };
  state.announcements.set(ann.id, ann);
  createCard(ann, media, { local:true });
  for (const peerId of state.directPeers.keys()) await replaceDirectTracks(peerId);
  sendWs({ type:'stream-upsert', stream:ann });
}

async function ensureDirectPeer(peerId) {
  if (!peerId || peerId === state.participantId || state.directPeers.has(peerId)) return state.directPeers.get(peerId);
  const pc = makePeerConnection();
  const peer = {
    peerId, pc, polite:state.participantId.localeCompare(peerId) > 0, makingOffer:false, ignoreOffer:false,
    video:pc.addTransceiver('video', { direction:'sendrecv' }),
    audio:pc.addTransceiver('audio', { direction:'sendrecv' }),
    remoteVideo:null, remoteAudio:null, requestedQuality:'auto',
  };
  state.directPeers.set(peerId, peer);

  pc.onicecandidate = ({ candidate }) => { if (candidate) sendWs({ type:'signal', target:peerId, signal:{ candidate } }); };
  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      sendWs({ type:'signal', target:peerId, signal:{ description:pc.localDescription } });
    } catch (e) { console.warn('negotiation', e); }
    finally { peer.makingOffer = false; }
  };
  pc.ontrack = ({ track }) => {
    if (track.kind === 'video') peer.remoteVideo = track;
    if (track.kind === 'audio') peer.remoteAudio = track;
    maybeAttachDirectStream(peerId);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      try { pc.restartIce(); } catch {}
    }
  };
  if (state.localShare) setTimeout(() => replaceDirectTracks(peerId).catch(console.error), 0);
  return peer;
}

async function handleDirectSignal(from, signal) {
  const peer = await ensureDirectPeer(from); if (!peer) return;
  const pc = peer.pc;
  try {
    if (signal.description) {
      const desc = signal.description;
      const collision = desc.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;
      if (collision && peer.polite) {
        await Promise.all([pc.setLocalDescription({ type:'rollback' }), pc.setRemoteDescription(desc)]);
      } else {
        await pc.setRemoteDescription(desc);
      }
      if (desc.type === 'offer') {
        await pc.setLocalDescription();
        sendWs({ type:'signal', target:from, signal:{ description:pc.localDescription } });
      }
    } else if (signal.candidate) {
      try { await pc.addIceCandidate(signal.candidate); } catch (e) { if (!peer.ignoreOffer) throw e; }
    }
  } catch (e) { console.warn('direct signal', e); }
}

function directQualityParams(sourceProfile, choice) {
  const src = profile(sourceProfile);
  if (choice === '360') return { maxBitrate:src.low, maxFramerate:15, scaleResolutionDownBy:Math.max(1, src.width / 640) };
  if (choice === '720') return { maxBitrate:Math.min(src.bitrate, sourceProfile === '720p30' ? 1_800_000 : 3_000_000), maxFramerate:Math.min(src.fps, 60), scaleResolutionDownBy:Math.max(1, src.width / 1280) };
  if (choice === '1080') return { maxBitrate:src.bitrate, maxFramerate:src.fps, scaleResolutionDownBy:1 };
  return { maxBitrate:src.bitrate, maxFramerate:src.fps, scaleResolutionDownBy:1 };
}

async function applyDirectQuality(peerId, choice='auto') {
  const peer = state.directPeers.get(peerId); if (!peer || !state.localShare) return;
  peer.requestedQuality = choice;
  const sender = peer.video.sender;
  const params = sender.getParameters();
  if (!params.encodings?.length) params.encodings = [{}];
  const q = directQualityParams(state.localShare.profileId, choice);
  params.encodings[0].maxBitrate = q.maxBitrate;
  params.encodings[0].maxFramerate = q.maxFramerate;
  params.encodings[0].scaleResolutionDownBy = q.scaleResolutionDownBy;
  params.degradationPreference = state.localShare.profileId === '720p30' ? 'maintain-resolution' : 'balanced';
  await sender.setParameters(params).catch(() => {});
}

async function replaceDirectTracks(peerId) {
  const peer = state.directPeers.get(peerId); if (!peer || !state.localShare) return;
  const media = state.localShare.media;
  await peer.video.sender.replaceTrack(media.getVideoTracks()[0] || null);
  await peer.audio.sender.replaceTrack(media.getAudioTracks()[0] || null);
  await applyDirectQuality(peerId, peer.requestedQuality || 'auto');
}

function maybeAttachDirectStream(ownerId) {
  const ann = [...state.announcements.values()].find(s => s.ownerId === ownerId && s.mode === 'direct');
  const peer = state.directPeers.get(ownerId);
  if (!ann || !peer?.remoteVideo) return;
  const media = new MediaStream([peer.remoteVideo, ...(peer.remoteAudio ? [peer.remoteAudio] : [])]);
  createCard(ann, media, { local:false, statsPc:peer.pc });
}

function removeDirectPeer(peerId) {
  const peer = state.directPeers.get(peerId); if (!peer) return;
  try { peer.pc.close(); } catch {}
  state.directPeers.delete(peerId);
}

async function handleAnnouncement(ann) {
  state.announcements.set(ann.id, ann);
  if (ann.ownerId === state.participantId) { renderShell(); return; }
  if (state.mode === 'cloud') await ensureCloudSubscription(ann);
  else { await ensureDirectPeer(ann.ownerId); maybeAttachDirectStream(ann.ownerId); }
  renderShell();
}

async function removeAnnouncement(streamId) {
  const ann = state.announcements.get(streamId);
  state.announcements.delete(streamId);
  if (state.mode === 'cloud') await suspendCloudSubscription(streamId);
  await removeCard(streamId);
  if (ann?.ownerId === state.participantId && state.localShare?.ann.id === streamId) state.localShare = null;
  renderShell();
}

async function processSocketMessage(msg) {
  if (msg.type === 'snapshot') {
    state.participants = new Map((msg.participants || []).map(p => [p.id,p]));
    const incoming = new Map((msg.streams || []).map(s => [s.id,s]));
    for (const oldId of [...state.announcements.keys()]) if (!incoming.has(oldId) && oldId !== state.localShare?.ann.id) await removeAnnouncement(oldId);
    for (const ann of incoming.values()) await handleAnnouncement(ann);
    if (state.mode === 'direct') for (const p of state.participants.values()) if (p.id !== state.participantId) ensureDirectPeer(p.id).catch(console.error);
    renderShell();
    return;
  }
  if (msg.type === 'participant-joined' || msg.type === 'participant-updated') {
    state.participants.set(msg.participant.id, msg.participant);
    if (state.mode === 'direct' && msg.participant.id !== state.participantId) ensureDirectPeer(msg.participant.id).catch(console.error);
    renderPeople(); return;
  }
  if (msg.type === 'participant-left') {
    state.participants.delete(msg.participantId);
    removeDirectPeer(msg.participantId);
    for (const id of msg.removedStreams || []) await removeAnnouncement(id);
    renderShell(); return;
  }
  if (msg.type === 'stream-upsert') { await handleAnnouncement(msg.stream); return; }
  if (msg.type === 'stream-remove') { await removeAnnouncement(msg.streamId); return; }
  if (msg.type === 'signal' && state.mode === 'direct') { await handleDirectSignal(msg.from, msg.signal); return; }
  if (msg.type === 'quality-request' && state.mode === 'direct') { await applyDirectQuality(msg.from, msg.quality); }
}

async function joinRoom() {
  state.joined = false;
  const result = await api(`/api/rooms/${state.roomId}/join`, { method:'POST', body:{ name:myName(), mode:state.mode } });
  state.participantId = result.participantId;
  state.token = result.token;
  state.mode = result.mode || state.mode;
  state.participants = new Map((result.snapshot.participants || []).map(p => [p.id,p]));
  state.announcements = new Map((result.snapshot.streams || []).map(s => [s.id,s]));
  await connectSocket();
}

async function connectSocket() {
  if (state.manualLeave) return;
  const url = wsUrl(state.apiBase, `/api/rooms/${state.roomId}/socket?id=${encodeURIComponent(state.participantId)}&token=${encodeURIComponent(state.token)}`);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url); state.ws = ws;
    let settled = false;
    const failTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      reject(new Error('Room socket connection timed out.'));
    }, 10000);
    els.connectionBanner.classList.remove('hidden'); setStatus('Connecting', 'reconnecting');
    ws.onopen = () => {
      clearTimeout(failTimer);
      state.joined = true;
      setRoomControlsEnabled(true);
      els.setupError.classList.add('hidden');
      els.connectionBanner.classList.add('hidden');
      clearTimeout(state.reconnectTimer);
      clearInterval(state.heartbeat);
      state.heartbeat = setInterval(() => sendWs({ type:'ping' }), 20000);
      renderShell();
      if (!settled) { settled = true; resolve(); }
    };
    ws.onmessage = e => { try { processSocketMessage(JSON.parse(e.data)).catch(console.error); } catch {} };
    ws.onerror = () => {
      if (!settled) {
        clearTimeout(failTimer);
        settled = true;
        reject(new Error('Could not open the room WebSocket. Check the Worker URL and deployment.'));
      }
    };
    ws.onclose = () => {
      clearTimeout(failTimer);
      clearInterval(state.heartbeat);
      state.joined = false;
      setRoomControlsEnabled(false);
      if (!settled) { settled = true; reject(new Error('Room socket closed before joining.')); }
      if (state.manualLeave) return;
      els.connectionBanner.classList.remove('hidden'); setStatus('Reconnecting', 'reconnecting');
      state.reconnectTimer = setTimeout(rejoinAfterDisconnect, 1200);
    };
  });
}

async function rejoinAfterDisconnect() {
  if (state.manualLeave) return;
  state.joined = false;
  try {
    for (const peer of state.directPeers.values()) try { peer.pc.close(); } catch {}
    state.directPeers.clear();
    for (const sub of state.cloudSubs.values()) try { sub.pc.close(); } catch {}
    state.cloudSubs.clear();
    const result = await api(`/api/rooms/${state.roomId}/join`, { method:'POST', body:{ name:myName(), mode:state.mode } });
    state.participantId = result.participantId; state.token = result.token; state.mode = result.mode || state.mode;
    if (state.localShare) {
      const old = state.localShare.ann;
      const ann = { ...old, id:`${state.participantId}-${uid(5)}`, ownerId:state.participantId, ownerName:myName() };
      state.announcements.delete(old.id); await removeCard(old.id); state.localShare.ann = ann; state.announcements.set(ann.id,ann); createCard(ann,state.localShare.media,{local:true,statsPc:state.localShare.pc});
    }
    await connectSocket();
    if (state.localShare) setTimeout(() => sendWs({ type:'stream-upsert', stream:state.localShare.ann }), 500);
  } catch { state.reconnectTimer = setTimeout(rejoinAfterDisconnect, 2500); }
}

function updateStats() {
  for (const entry of state.cards.values()) {
    const pc = entry.statsPc; if (!pc) continue;
    pc.getStats().then(stats => {
      let chosen = null;
      stats.forEach(r => {
        if (entry.local && r.type === 'outbound-rtp' && r.kind === 'video' && !r.isRemote) chosen = r;
        if (!entry.local && r.type === 'inbound-rtp' && r.kind === 'video') chosen = r;
      });
      if (!chosen) return;
      const bytes = entry.local ? chosen.bytesSent : chosen.bytesReceived;
      const now = performance.now();
      let mbps = null;
      if (entry.lastAt && bytes >= entry.lastBytes) mbps = ((bytes-entry.lastBytes)*8/1e6)/((now-entry.lastAt)/1000);
      entry.lastAt = now; entry.lastBytes = bytes;
      const dims = chosen.frameWidth && chosen.frameHeight ? `${chosen.frameWidth}×${chosen.frameHeight}` : '';
      const fps = chosen.framesPerSecond ? `${Math.round(chosen.framesPerSecond)}fps` : '';
      const rate = mbps != null ? `${mbps.toFixed(mbps < 1 ? 2 : 1)} Mbps` : '';
      entry.card.querySelector('.stream-health').textContent = [dims,fps,rate].filter(Boolean).join(' · ') || 'Live';
    }).catch(() => {});
  }
}

function modePickerInit() {
  document.querySelectorAll('input[name="roomMode"]').forEach(input => input.addEventListener('change', () => {
    document.querySelectorAll('.mode-card').forEach(c => c.classList.toggle('selected', c.dataset.modeCard === input.value));
  }));
}

async function boot() {
  modePickerInit(); updateQualityHint();
  els.shareQuality.addEventListener('change', updateQualityHint);
  const config = await fetch('/api/config').then(r => r.json()).catch(() => ({ roomApiUrl:'' }));
  state.apiBase = normalizeApiBase(config.roomApiUrl);
  const params = new URLSearchParams(location.search);
  const roomId = params.get('room');
  if (!roomId) { show('home'); return; }
  if (!state.apiBase) { showSetupFailure('Room backend not configured', 'ROOM_API_URL is missing in Vercel. Add your Cloudflare Worker URL and redeploy.'); return; }
  state.roomId = roomId;
  state.mode = params.get('mode') === 'direct' ? 'direct' : 'cloud';
  els.inviteLink.value = location.href;
  show('room');
  setRoomControlsEnabled(false);
  try {
    const health = await api('/health');
    if (!health?.ok || !health?.roomsBinding) throw new Error('Cloudflare Worker is reachable, but the ROOMS Durable Object binding is missing.');
    if (state.mode === 'cloud' && !health?.realtimeConfigured) throw new Error('Cloudflare Worker is missing the Realtime App ID/App Secret. Add them as Worker secrets.');
  } catch (e) {
    setStatus('Backend unavailable');
    showSetupFailure('Room backend check failed', `${e.message}\n\nRoom server: ${state.apiBase}`);
    return;
  }
  try { await joinRoom(); }
  catch (e) {
    state.joined = false;
    state.participants.clear();
    state.announcements.clear();
    renderPeople();
    setStatus('Could not join');
    showSetupFailure('Could not join room', `${e.message}\n\nRoom server: ${state.apiBase}`);
  }
  state.statsTimer = setInterval(updateStats, 2000);
}

els.createRoom.addEventListener('click', () => {
  const mode = document.querySelector('input[name="roomMode"]:checked')?.value || 'cloud';
  const url = new URL(location.href); url.search = ''; url.searchParams.set('room', uid(18)); url.searchParams.set('mode', mode); location.href = url.toString();
});
els.shareScreen.addEventListener('click', startSharing);
els.emptyShareButton.addEventListener('click', startSharing);
els.stopSharing.addEventListener('click', stopSharing);
els.copyInvite.addEventListener('click', async () => { await navigator.clipboard.writeText(els.inviteLink.value).catch(() => {}); toast('Invite link copied'); });
els.backToGrid.addEventListener('click', returnToGrid);
els.fullscreenFocus.addEventListener('click', () => els.focusMount.requestFullscreen?.().catch(() => {}));
els.audioUnlock.addEventListener('click', () => {
  state.audioUnlocked = true;
  for (const entry of state.cards.values()) if (!entry.local) { entry.video.muted = false; entry.video.play().catch(() => {}); }
  updateAudioButton();
});
els.leaveRoom.addEventListener('click', async () => { state.manualLeave = true; await stopSharing().catch(() => {}); try { state.ws?.close(); } catch {} location.href = '/'; });

window.addEventListener('beforeunload', () => { state.manualLeave = true; try { state.ws?.close(); } catch {} });
document.addEventListener('visibilitychange', () => {
  if (state.mode !== 'cloud') return;
  if (document.hidden) {
    setTimeout(() => {
      if (!document.hidden) return;
      state.suspended = true;
      for (const id of [...state.cloudSubs.keys()]) suspendCloudSubscription(id).catch(() => {});
    }, 2500);
  } else {
    state.suspended = false;
    for (const ann of state.announcements.values()) if (ann.ownerId !== state.participantId) ensureCloudSubscription(ann).catch(console.error);
  }
});

boot();
