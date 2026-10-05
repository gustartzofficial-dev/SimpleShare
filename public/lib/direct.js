export function createDirectTransport({
  state,
  $,
  log,
  randomId,
  setStatus,
  toast,
  updateCaptureAvailability,
  QUALITY,
  escapeHtml,
  showLocalTile,
  showLiveTile,
  showIdleTile,
  ensureTile,
  renderPeople,
  renderGrid,
  dropStream,
  addStream,
  removeTile,
  reportWatching,
  startTileStats,
  setPlaybackVolume,
  resumePlayback,
  refreshGlobalAudioButton,
  reconcileSnapshot,
}) {
  const P2P_ICE = [
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
    {
      urls: [
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
        'turns:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ];
  const P2P_BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/',
  ];
  const P2P_HELLO_MS = 3000; // presence announce interval
  const P2P_GONE_MS = 20000; // silence after which a peer is considered gone
  const P2P_ICE_FLUSH_MS = 220;

  const P2P = {
    active: false,
    rev: 0,
    mq: null,
    key: null,
    topic: '',
    brokerIndex: 0,
    peers: new Map(), // participantId -> { id, name, stream, firstSeen, at }
    joinedAt: 0,
    signature: '',
    out: new Map(),
    in: new Map(),
    helloTimer: null,
    reapTimer: null,
    iceOut: new Map(),
    resumedAt: 0,
    wireTimer: null,
  };

  function p2pWireChannel(peerId, channel) {
    channel.onopen = () => {
      p2pTouch(peerId);
      log(`link to ${p2pPeerName(peerId)} established`, 'debug');
    };
    channel.onmessage = () => p2pTouch(peerId);
    channel.onclose = () => log(`link to ${p2pPeerName(peerId)} closed`, 'debug');
    return channel;
  }
  function p2pChannel(peerId) {
    const out = P2P.out.get(peerId)?.dc,
      inb = P2P.in.get(peerId)?.dc;
    if (out?.readyState === 'open') return out;
    if (inb?.readyState === 'open') return inb;
    return null;
  }
  const p2pLinked = (peerId) => Boolean(p2pChannel(peerId));
  function p2pTouch(peerId) {
    const known = P2P.peers.get(peerId);
    if (known) {
      known.at = Date.now();
      return;
    }
    P2P.peers.set(peerId, {
      id: peerId,
      name: 'peer',
      stream: null,
      firstSeen: Date.now(),
      at: Date.now(),
    });
    p2pRebuild();
  }

  function p2pKeepalive() {
    for (const peerId of new Set([...P2P.out.keys(), ...P2P.in.keys()])) {
      const channel = p2pChannel(peerId);
      if (!channel) continue;
      try {
        channel.send('.');
      } catch {}
    }
  }
  function p2pQueueCandidate(target, cand) {
    let q = P2P.iceOut.get(target);
    if (!q) {
      q = { cands: [], timer: null };
      P2P.iceOut.set(target, q);
    }
    q.cands.push(cand);
    if (q.timer) return;
    q.timer = setTimeout(() => {
      q.timer = null;
      const batch = q.cands.splice(0);
      if (batch.length) p2pSend(target, { k: 'ice', cands: batch });
    }, P2P_ICE_FLUSH_MS);
  }
  function p2pCloseOut(peerId) {
    const entry = P2P.out.get(peerId);
    if (!entry) return;
    try {
      entry.pc.close();
    } catch {}
    P2P.out.delete(peerId);
  }
  function p2pCloseIn(ownerId) {
    const entry = P2P.in.get(ownerId);
    if (!entry) return;
    try {
      entry.pc.close();
    } catch {}
    P2P.in.delete(ownerId);
  }
  function p2pCloseAllOutbound() {
    for (const peerId of [...P2P.out.keys()]) p2pCloseOut(peerId);
  }

  const mqLen = (n) => {
    const o = [];
    do {
      let b = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) b |= 128;
      o.push(b);
    } while (n > 0);
    return o;
  };
  const mqStr = (v) => {
    const b = new TextEncoder().encode(v);
    return [b.length >> 8, b.length & 255, ...b];
  };
  const mqPacket = (type, flags, body) =>
    new Uint8Array([(type << 4) | flags, ...mqLen(body.length), ...body]);

  function mqParse(buf) {
    const packets = [];
    let i = 0;
    while (i < buf.length) {
      if (buf.length - i < 2) break;
      const type = buf[i] >> 4;
      let mult = 1,
        len = 0,
        j = i + 1,
        b;
      do {
        if (j >= buf.length) return [packets, buf.slice(i)];
        b = buf[j++];
        len += (b & 127) * mult;
        mult *= 128;
        if (mult > 268435456) throw new Error('Invalid MQTT packet length.');
      } while (b & 128);
      if (buf.length < j + len) return [packets, buf.slice(i)];
      packets.push({ type, body: buf.slice(j, j + len) });
      i = j + len;
    }
    return [packets, buf.slice(i)];
  }

  function mqttConnect(url, onMessage) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, ['mqtt']);
      ws.binaryType = 'arraybuffer';
      let rest = new Uint8Array(0),
        settled = false,
        pingTimer = null,
        packetId = 1;
      const fail = (why) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(pingTimer);
        try {
          ws.close();
        } catch {}
        reject(new Error(why));
      };
      const timer = setTimeout(() => fail('broker timed out'), 7000);

      const client = {
        ws,
        publish(topic, bytes) {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(mqPacket(3, 0, [...mqStr(topic), ...bytes]));
        },
        subscribe(topic) {
          if (ws.readyState !== WebSocket.OPEN) return;
          const id = packetId++ & 0xffff;
          ws.send(mqPacket(8, 2, [id >> 8, id & 255, ...mqStr(topic), 0]));
        },
        close() {
          clearInterval(pingTimer);
          try {
            ws.close();
          } catch {}
        },
      };

      ws.onopen = () => {
        const clientId = `ss${randomId(10)}`; // 22 chars, within spec
        ws.send(mqPacket(1, 0, [...mqStr('MQTT'), 4, 0x02, 0, 60, ...mqStr(clientId)]));
      };
      ws.onerror = () => fail('broker connection failed');
      ws.onclose = () => {
        clearInterval(pingTimer);
        if (!settled) fail('broker closed the connection');
        else onMessage(null, null);
      };
      ws.onmessage = (e) => {
        const chunk = new Uint8Array(e.data);
        if (chunk.length + rest.length > 262144) {
          try {
            ws.close(1009, 'message too large');
          } catch {}
          return;
        }
        const joined = new Uint8Array(rest.length + chunk.length);
        joined.set(rest);
        joined.set(chunk, rest.length);
        const [packets, remainder] = mqParse(joined);
        rest = remainder;
        for (const pkt of packets) {
          if (pkt.type === 2) {
            // CONNACK
            if (pkt.body[1] !== 0)
              return fail(`broker refused the connection (code ${pkt.body[1]})`);
            clearTimeout(timer);
            settled = true;
            pingTimer = setInterval(() => {
              if (ws.readyState === WebSocket.OPEN) ws.send(mqPacket(12, 0, []));
            }, 30000);
            resolve(client);
          } else if (pkt.type === 3) {
            // PUBLISH (QoS 0)
            const tLen = (pkt.body[0] << 8) | pkt.body[1];
            const topic = new TextDecoder().decode(pkt.body.slice(2, 2 + tLen));
            onMessage(topic, pkt.body.slice(2 + tLen));
          }
        }
      };
    });
  }

  const sha256 = async (text) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

  async function p2pDeriveRoom(roomId) {
    P2P.key = await crypto.subtle.importKey(
      'raw',
      await sha256(`simpleshare-key/${roomId}`),
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    );
    P2P.topic = toHex(await sha256(`simpleshare-topic/${roomId}`)).slice(0, 24);
  }
  async function p2pSeal(obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        P2P.key,
        new TextEncoder().encode(JSON.stringify(obj)),
      ),
    );
    const out = new Uint8Array(12 + ct.length);
    out.set(iv);
    out.set(ct, 12);
    return out;
  }
  async function p2pOpen(bytes) {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12) },
      P2P.key,
      bytes.slice(12),
    );
    return JSON.parse(new TextDecoder().decode(plain));
  }

  const p2pRoomTopic = () => `ss/${P2P.topic}/room`;
  const p2pPeerTopic = (id) => `ss/${P2P.topic}/p/${id}`;

  async function p2pPublish(topic, obj) {
    if (!P2P.mq) {
      log(`cannot publish ${obj.k || '?'} — no broker connection`, 'error');
      return;
    }
    try {
      P2P.mq.publish(topic, await p2pSeal(obj));
      if (obj.k && obj.k !== 'hello') log(`-> sent ${obj.k}`, 'debug');
    } catch (err) {
      log(`publish ${obj.k || '?'} failed: ${err.message}`, 'error');
    }
  }
  const p2pSend = (target, signal) =>
    p2pPublish(p2pPeerTopic(target), { from: state.participantId, ...signal });
  const p2pPeerName = (id) => state.people.get(id)?.name || P2P.peers.get(id)?.name || 'peer';
  function p2pHello() {
    return p2pPublish(p2pRoomTopic(), {
      k: 'hello',
      id: state.participantId,
      name: state.name,
      stream: state.share
        ? {
            id: state.share.streamId,
            profile: state.share.profile,
            audio: state.share.media.getAudioTracks().length > 0,
          }
        : null,
    });
  }

  async function p2pOnRoomMessage(msg) {
    if (msg.k === 'hello') {
      if (msg.id === state.participantId) return;
      const known = P2P.peers.get(msg.id);
      if (known?.stream && !msg.stream) p2pCloseIn(msg.id);
      P2P.peers.set(msg.id, {
        id: msg.id,
        name: safeP2PName(msg.name),
        stream: msg.stream || null,
        firstSeen: known?.firstSeen || Date.now(),
        at: Date.now(),
      });
      p2pRebuild();
    } else if (msg.k === 'gone') {
      P2P.peers.delete(msg.id);
      p2pCloseOut(msg.id);
      p2pCloseIn(msg.id);
      p2pRebuild();
    }
  }
  const safeP2PName = (v) =>
    String(v || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 28) || 'Guest';

  function p2pReap() {
    if (!P2P.mq) return;
    if (Date.now() - P2P.resumedAt < P2P_GONE_MS) return;
    const cutoff = Date.now() - P2P_GONE_MS;
    let changed = false;
    for (const [id, peer] of P2P.peers) {
      if (peer.at >= cutoff) continue;
      if (p2pLinked(id)) {
        peer.at = Date.now();
        continue;
      }
      P2P.peers.delete(id);
      p2pCloseOut(id);
      p2pCloseIn(id);
      changed = true;
    }
    if (changed) p2pRebuild();
  }
  function p2pStreamAnnouncement(ownerId, ownerName, stream) {
    return {
      id: stream.id || `${ownerId}-share`,
      ownerId,
      ownerName,
      profile: stream.profile,
      audio: Boolean(stream.audio),
      sessionId: `p2p:${ownerId}`,
      videoTrackName: 'p2p-video',
      audioTrackName: stream.audio ? 'p2p-audio' : null,
      mode: 'p2p',
      p2p: true,
    };
  }

  function p2pRebuild() {
    const participants = [
      { id: state.participantId, name: state.name, joinedAt: P2P.joinedAt, mode: 'p2p' },
      ...[...P2P.peers.values()].map((p) => ({
        id: p.id,
        name: p.name,
        joinedAt: p.firstSeen,
        mode: 'p2p',
      })),
    ];
    const streams = [];
    for (const peer of P2P.peers.values()) {
      if (peer.stream) streams.push(p2pStreamAnnouncement(peer.id, peer.name, peer.stream));
    }
    for (const [ownerId, conn] of P2P.in) {
      if (streams.some((st) => st.ownerId === ownerId)) continue;
      if (!conn.pc || conn.pc.connectionState === 'closed' || conn.pc.connectionState === 'failed')
        continue;
      const peer = P2P.peers.get(ownerId);
      streams.push(
        p2pStreamAnnouncement(
          ownerId,
          peer?.name || 'peer',
          peer?.stream || { profile: '720p60', audio: false },
        ),
      );
    }
    if (state.share) {
      streams.push(
        p2pStreamAnnouncement(state.participantId, state.name, {
          id: state.share.streamId,
          profile: state.share.profile,
          audio: state.share.media.getAudioTracks().length > 0,
        }),
      );
    }
    const signature = JSON.stringify([participants.map((p) => [p.id, p.name]), streams]);
    if (signature === P2P.signature) return;
    P2P.signature = signature;
    reconcileSnapshot({ rev: ++P2P.rev, participants, streams }, 'p2p').catch((err) =>
      log(`p2p reconcile: ${err.message}`, 'warn'),
    );
  }
  async function p2pOfferTo(peerId) {
    if (!state.share || peerId === state.participantId) return;
    p2pCloseOut(peerId);
    const pc = new RTCPeerConnection({ iceServers: P2P_ICE });
    const entry = { pc, queue: [] };
    P2P.out.set(peerId, entry);
    entry.dc = p2pWireChannel(peerId, pc.createDataChannel('ss-presence', { ordered: true }));
    for (const track of state.share.media.getTracks()) pc.addTrack(track, state.share.media);
    const q = QUALITY[state.share.profile] || QUALITY['720p60'];
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue;
      try {
        const params = sender.getParameters();
        params.encodings = [{ maxBitrate: q.bitrate, maxFramerate: q.fps }];
        await sender.setParameters(params);
      } catch {}
    }
    entry.seen = new Set();
    pc.onicecandidate = (e) => {
      if (!e.candidate) {
        log(
          `ICE gathering done for ${p2pPeerName(peerId)}: ${[...entry.seen].join(', ') || 'NO CANDIDATES'}`,
        );
        return;
      }
      entry.seen.add(e.candidate.type || '?');
      p2pQueueCandidate(peerId, e.candidate.toJSON());
    };
    pc.oniceconnectionstatechange = () =>
      log(`ICE -> ${pc.iceConnectionState} (to ${p2pPeerName(peerId)})`, 'debug');
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        log(`connected to ${p2pPeerName(peerId)}`);
        pc.getStats()
          .then((st) =>
            st.forEach((r) => {
              if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') {
                st.forEach((c) => {
                  if (c.id === r.localCandidateId && c.candidateType === 'relay')
                    log(
                      `routed through a TURN relay (${c.protocol || '?'}) — direct path unavailable`,
                      'warn',
                    );
                });
              }
            }),
          )
          .catch(() => {});
      }
      if (pc.connectionState === 'failed') {
        log(`direct route to ${p2pPeerName(peerId)} failed — no relay in P2P mode`, 'error');
        p2pCloseOut(peerId);
      }
    };
    log(`building offer for ${p2pPeerName(peerId)} (${pc.getSenders().length} tracks)`);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await p2pSend(peerId, { k: 'offer', sdp: offer.sdp });
    log(`offer sent to ${p2pPeerName(peerId)}`);
  }

  async function p2pAcceptOffer(ownerId, sdp) {
    const ann = [...state.streams.values()].find((a) => a.ownerId === ownerId);
    const entry = ann ? state.subs.get(ann.id) : null;
    if (!ann) {
      log(`offer from ${p2pPeerName(ownerId)} but no stream announced by them`, 'warn');
      return;
    }
    if (!entry) {
      log(`offer from ${ann.ownerName} but we are not watching that stream`, 'warn');
      return;
    }
    p2pCloseIn(ownerId);
    const pc = new RTCPeerConnection({ iceServers: P2P_ICE });
    const conn = { pc, queue: [] };
    P2P.in.set(ownerId, conn);
    const tile = state.tiles.get(ann.id);
    pc.ondatachannel = (e) => {
      conn.dc = p2pWireChannel(ownerId, e.channel);
    };
    pc.ontrack = (e) => {
      if (!tile) return;
      clearTimeout(entry.stall);
      if (e.track.kind === 'video') {
        for (const old of entry.videoMedia.getVideoTracks()) entry.videoMedia.removeTrack(old);
        entry.videoMedia.addTrack(e.track);
        tile.video.srcObject = entry.videoMedia;
        tile.video.play().catch(() => {});
        tile.note.classList.add('hidden');
        tile.lastFrameAt = Date.now();
        log(`receiving video from ${ann.ownerName} (direct)`);
      } else {
        entry.audioMedia = new MediaStream([e.track]);
        tile.audio.srcObject = entry.audioMedia;
        tile.audioBtn.classList.remove('hidden');
        tile.volumeWrap.classList.add('hidden');
        if (!state.audioMuted) {
          tile.audio.muted = false;
          setPlaybackVolume(tile, state.volume);
          resumePlayback();
          tile.audio.play().catch(() => {
            tile.audio.muted = true;
          });
        }
      }
    };
    conn.seen = new Set();
    pc.onicecandidate = (e) => {
      if (!e.candidate) {
        log(
          `ICE gathering done for ${ann.ownerName}: ${[...conn.seen].join(', ') || 'NO CANDIDATES'}`,
        );
        return;
      }
      conn.seen.add(e.candidate.type || '?');
      p2pQueueCandidate(ownerId, e.candidate.toJSON());
    };
    pc.oniceconnectionstatechange = () =>
      log(`ICE -> ${pc.iceConnectionState} (from ${ann.ownerName})`, 'debug');
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected')
        log(`direct connection to ${ann.ownerName} established`);
      if (pc.connectionState !== 'failed' || !tile) return;
      log(`direct route from ${ann.ownerName} failed`, 'error');
      tile.note.textContent = 'No direct route to this peer.';
      tile.note.classList.remove('hidden');
    };
    await pc.setRemoteDescription({ type: 'offer', sdp });
    log(`accepted offer from ${ann.ownerName}, ${conn.queue.length} queued candidates`);
    for (const cand of conn.queue.splice(0)) {
      try {
        await pc.addIceCandidate(cand);
      } catch {}
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await p2pSend(ownerId, { k: 'answer', sdp: answer.sdp });
    log(`answer sent to ${ann.ownerName}`);
  }

  async function p2pOnSignal(from, raw) {
    let sig;
    try {
      sig = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return;
    }
    if (sig.k !== 'ice') log(`<- got ${sig.k} from ${p2pPeerName(from)}`, 'debug');
    if (sig.k === 'want') {
      if (!state.share) {
        log(`${p2pPeerName(from)} asked to watch, but we are not sharing`, 'warn');
        return;
      }
      try {
        await p2pOfferTo(from);
      } catch (err) {
        log(`could not offer to ${p2pPeerName(from)}: ${err.message}`, 'error');
      }
      return;
    }
    if (sig.k === 'bye') {
      p2pCloseOut(from);
      return;
    }
    if (sig.k === 'offer') {
      await p2pAcceptOffer(from, sig.sdp);
      return;
    }
    if (sig.k === 'answer') {
      const out = P2P.out.get(from);
      if (!out) {
        log(`answer from ${p2pPeerName(from)} with no matching connection`, 'warn');
        return;
      }
      if (out.pc.signalingState === 'stable') {
        log(`answer from ${p2pPeerName(from)} ignored (already stable)`, 'warn');
        return;
      }
      await out.pc.setRemoteDescription({ type: 'answer', sdp: sig.sdp });
      for (const cand of out.queue.splice(0)) {
        try {
          await out.pc.addIceCandidate(cand);
        } catch {}
      }
      return;
    }
    if (sig.k === 'ice') {
      const conn = P2P.out.get(from) || P2P.in.get(from);
      if (!conn) return;
      const cands = sig.cands || (sig.cand ? [sig.cand] : []);
      for (const cand of cands) {
        if (!conn.pc.remoteDescription) {
          conn.queue.push(cand);
          continue;
        }
        try {
          await conn.pc.addIceCandidate(cand);
        } catch {}
      }
    }
  }
  async function subscribeP2P(ann) {
    log(`watching ${ann.ownerName} (direct)`);
    const videoMedia = new MediaStream();
    const entry = {
      videoMedia,
      audioMedia: null,
      stall: null,
      strikes: 0,
      subscribedAt: Date.now(),
      attempt: (state.subAttempts.get(ann.id) || 0) + 1,
      target: {
        sessionId: `p2p:${ann.ownerId}`,
        videoTrackName: 'p2p-video',
        audioTrackName: ann.audio ? 'p2p-audio' : null,
      },
      subs: [
        {
          unsubscribe: () => {
            p2pSend(ann.ownerId, { k: 'bye' });
            p2pCloseIn(ann.ownerId);
          },
        },
      ],
    };
    state.subs.set(ann.id, entry);
    state.subAttempts.set(ann.id, entry.attempt);
    const tile = showLiveTile(ann, videoMedia);
    tile.note.textContent = 'Connecting directly…';
    tile.note.classList.remove('hidden');
    entry.stall = setTimeout(() => {
      if (entry.videoMedia.getVideoTracks().length) return;
      log(`no direct route to ${ann.ownerName} after 20s`, 'error');
      tile.note.textContent = 'No direct route — this network may need a relay.';
    }, 20000);
    await p2pSend(ann.ownerId, { k: 'want' });
  }

  async function p2pAnnounceShare(share) {
    await p2pHello();
    p2pRebuild();
    log('announced to room (peer-to-peer)');
    setStatus('Sharing · P2P', 'ok');
    for (const id of P2P.peers.keys()) if (P2P.out.has(id)) await p2pOfferTo(id);
  }

  async function p2pConnectBroker() {
    let lastError = null;
    for (let attempt = 0; attempt < P2P_BROKERS.length; attempt++) {
      const url = P2P_BROKERS[(P2P.brokerIndex + attempt) % P2P_BROKERS.length];
      const host = new URL(url).host;
      try {
        log(`connecting to rendezvous ${host}`);
        const client = await mqttConnect(url, (topic, bytes) => {
          if (topic === null) {
            if (P2P.active) p2pBrokerLost();
            return;
          }
          p2pOpen(bytes)
            .then((msg) => {
              if (topic === p2pRoomTopic()) return p2pOnRoomMessage(msg);
              if (msg.from && msg.from !== state.participantId) return p2pOnSignal(msg.from, msg);
            })
            .catch((err) => {
              if (err?.name === 'OperationError') return;
              log(`signal handler: ${err.message}`, 'error');
            });
        });
        P2P.brokerIndex = (P2P.brokerIndex + attempt) % P2P_BROKERS.length;
        P2P.mq = client;
        P2P.resumedAt = Date.now();
        client.subscribe(p2pRoomTopic());
        client.subscribe(p2pPeerTopic(state.participantId));
        log(`rendezvous ready (${host})`);
        const now = Date.now();
        for (const peer of P2P.peers.values()) peer.at = now;
        p2pHello().catch(() => {});
        return;
      } catch (err) {
        lastError = err;
        log(`${host} unavailable: ${err.message}`, 'warn');
      }
    }
    throw lastError || new Error('no rendezvous broker reachable');
  }

  function p2pBrokerLost() {
    if (!P2P.active || state.leaving) return;
    log('rendezvous connection dropped — trying the next broker', 'warn');
    for (const q of P2P.iceOut.values()) {
      clearTimeout(q.timer);
      q.timer = null;
      q.cands.length = 0;
    }
    setStatus('Reconnecting · P2P', 'warn');
    P2P.mq = null;
    P2P.brokerIndex += 1;
    setTimeout(
      () => {
        if (!P2P.active || state.leaving) return;
        p2pConnectBroker()
          .then(() => {
            setStatus(state.share ? 'Sharing · P2P' : 'Connected · P2P', 'ok');
            return p2pHello();
          })
          .catch((err) => {
            log(`rendezvous unreachable: ${err.message}`, 'error');
            setStatus('P2P offline', 'bad');
            p2pBrokerLost();
          });
      },
      2000 + Math.floor(Math.random() * 2000),
    );
  }

  async function enterP2PMode(reason) {
    if (P2P.active) return;
    P2P.active = true;
    log(`switching to peer-to-peer (${reason})`, 'warn');
    clearInterval(state.pollTimer);
    state.pollTimer = null;
    clearInterval(state.budgetTimer);
    state.budgetTimer = null;
    clearInterval(state.heartbeat);
    state.heartbeat = null;
    clearInterval(state.livenessTimer);
    state.livenessTimer = null;
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    state.socketSeq++;
    try {
      state.ws?.close(4002, 'p2p-fallback');
    } catch {}
    state.ws = null;
    state.appliedRev = 0;
    state.budgetBlocked = false;
    $('budgetBanner').classList.add('hidden');
    updateCaptureAvailability();
    $('budget').textContent = 'Direct room · No SFU usage';
    $('budget').className = 'budget';
    state.participantId = state.participantId || crypto.randomUUID();
    state.token = 'p2p';
    P2P.joinedAt = Date.now();
    P2P.signature = '';
    await p2pDeriveRoom(state.roomId);
    await p2pConnectBroker();

    updateCaptureAvailability();
    setStatus('Connected · P2P', 'ok');
    log(`joined over peer-to-peer as ${state.name}`);
    toast('Direct room connected. Invite everyone with this room’s direct link.');

    await p2pHello();
    p2pRebuild();
    P2P.helloTimer = setInterval(() => p2pHello().catch(() => {}), P2P_HELLO_MS);
    P2P.reapTimer = setInterval(p2pReap, 4000);
    P2P.wireTimer = setInterval(p2pKeepalive, 4000);
  }

  function p2pShutdown() {
    const client = P2P.mq;
    P2P.active = false;
    clearInterval(P2P.helloTimer);
    clearInterval(P2P.reapTimer);
    clearInterval(P2P.wireTimer);
    for (const q of P2P.iceOut.values()) clearTimeout(q.timer);
    P2P.iceOut.clear();
    p2pCloseAllOutbound();
    for (const id of [...P2P.in.keys()]) p2pCloseIn(id);
    try {
      p2pPublish(p2pRoomTopic(), { k: 'gone', id: state.participantId });
    } catch {}
    setTimeout(() => {
      try {
        client?.close();
      } catch {}
    }, 150);
    P2P.mq = null;
  }

  return {
    P2P,
    p2pShutdown,
    p2pHello,
    p2pRebuild,
    p2pBrokerLost,
    p2pAnnounceShare,
    subscribeP2P,
    p2pCloseAllOutbound,
    enterP2PMode,
  };
}
