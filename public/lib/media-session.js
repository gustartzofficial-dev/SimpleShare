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
    retireSession(pc);
    throw error;
  }
}
export async function closeSessionTracks(pc, tracks, send) {
  const mids = new Set(tracks.map((track) => track.mid));
  const closing = pc.getTransceivers().filter((t) => mids.has(t.mid));
  if (!closing.length) return;
  // Stop every member of the batch before generating its matching SDP.
  for (const transceiver of closing) transceiver.stop();
  await pc.setLocalDescription(await pc.createOffer());
  const response = await send({
    tracks: [...mids].map((mid) => ({ mid })),
    sessionDescription: pc.localDescription,
    force: false,
  });
  if (response.errorCode || !response.sessionDescription)
    throw new Error(
      response.errorDescription || response.errorCode || 'Track close returned no SDP answer',
    );
  if (response.tracks?.some((track) => track.errorCode))
    throw new Error('Track close was only partially accepted');
  await pc.setRemoteDescription(response.sessionDescription);
  if (pc.signalingState !== 'stable') throw new Error('Track close did not complete negotiation');
  // A session with no live media may lose its transport; never reuse that allocation.
  if (
    pc
      .getTransceivers()
      .every((t) => closing.includes(t) || t.stopped || t.currentDirection === 'stopped')
  )
    retireSession(pc);
}
