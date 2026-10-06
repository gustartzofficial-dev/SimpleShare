// An uncertain SDP exchange cannot safely be retried on the same SFU session.
export function retireSession(pc) {
  if (pc.connectionState === 'closed') return;
  pc.close();
  // close() does not dispatch this event in browsers; notify PartyTracks' session owner.
  pc.dispatchEvent(new Event('connectionstatechange'));
}
export async function runSessionMutation(pc, mutate) {
  try {
    if (pc.signalingState !== 'stable' || pc.connectionState === 'closed')
      throw new Error('Media session has an unfinished negotiation or is closed');
    return await mutate();
  } catch (error) {
    if (!(error.sessionSafe && pc.signalingState === 'stable')) retireSession(pc);
    throw error;
  }
}
const releasedTracks = new WeakMap();
export function activateSessionTrack(pc, mid) {
  const transceiver = pc.getTransceivers().find((t) => t.mid === mid);
  if (transceiver) releasedTracks.get(pc)?.delete(transceiver);
}
export async function closeSessionTracks(pc, tracks, send) {
  let released = releasedTracks.get(pc);
  if (!released) releasedTracks.set(pc, (released = new WeakSet()));
  const mids = new Set(tracks.map((track) => track.mid));
  const closing = pc.getTransceivers().filter((t) => mids.has(t.mid) && !released.has(t));
  if (!closing.length) return;
  // Forced media closure preserves the shared BUNDLE transport without an SDP exchange.
  let response;
  try {
    response = await send({ tracks: closing.map((t) => ({ mid: t.mid })), force: true });
  } catch (error) {
    error.sessionSafe = true;
    throw error;
  }
  if (response.sessionDescription || response.requiresImmediateRenegotiation)
    throw new Error(
      response.errorDescription || response.errorCode || 'Unexpected negotiated track close',
    );
  const accepted = closing.filter(
    (t) =>
      Array.isArray(response.tracks) &&
      response.tracks.some(
        (r) => r.mid === t.mid && (!r.errorCode || r.errorCode === 'close_track_error'),
      ),
  );
  for (const transceiver of accepted) {
    await transceiver.sender?.replaceTrack(null);
    released.add(transceiver);
  }
  if (response.errorCode || accepted.length !== closing.length)
    throw Object.assign(
      new Error(
        response.errorDescription ||
          response.errorCode ||
          'Track close was only partially accepted',
      ),
      { sessionSafe: true },
    );
  // A session with no live media may lose its transport; never reuse that allocation.
  if (
    pc
      .getTransceivers()
      .every((t) => released.has(t) || t.stopped || t.currentDirection === 'stopped')
  )
    retireSession(pc);
}
