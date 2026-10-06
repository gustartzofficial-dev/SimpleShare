export function createShareAudioMixer(
  primaryTrack,
  {
    Context = globalThis.AudioContext || globalThis.webkitAudioContext,
    Stream = globalThis.MediaStream,
    onExtraEnded = () => {},
  } = {},
) {
  if (!Context) throw new Error('Audio mixing is unavailable in this browser.');
  const context = new Context({ latencyHint: 'interactive' });
  const destination = context.createMediaStreamDestination();
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 3;
  limiter.ratio.value = 12;
  limiter.connect(destination);
  const primaryGain = context.createGain();
  const extraGain = context.createGain();
  primaryGain.connect(limiter);
  extraGain.connect(limiter);
  extraGain.gain.value = 0.6;
  let primarySource;
  if (primaryTrack) {
    primarySource = context.createMediaStreamSource(new Stream([primaryTrack]));
    primarySource.connect(primaryGain);
  }
  const silence = context.createConstantSource();
  silence.offset.value = 0;
  silence.connect(limiter);
  silence.start();
  let extra = null;
  let disposed = false;
  const stop = (stream) => stream?.getTracks().forEach((track) => track.stop());
  function removeExtra() {
    if (!extra) return;
    const previous = extra;
    extra = null;
    previous.stream
      .getTracks()
      .forEach((track) => track.removeEventListener('ended', previous.ended));
    previous.source.disconnect();
    stop(previous.stream);
  }
  return {
    track: destination.stream.getAudioTracks()[0],
    get extraTrack() {
      return extra?.track || null;
    },
    resume() {
      return context.resume();
    },
    setLevels(primary, secondary) {
      const level = (n) => Math.max(0, Math.min(1, Number(n) || 0));
      primaryGain.gain.setTargetAtTime(level(primary), context.currentTime, 0.015);
      extraGain.gain.setTargetAtTime(level(secondary), context.currentTime, 0.015);
    },
    setExtra(stream) {
      const track = stream.getAudioTracks()[0];
      if (disposed || !track || track.readyState === 'ended') {
        stop(stream);
        throw new Error(
          'That source did not provide live audio. Select a tab or app with audio enabled.',
        );
      }
      const source = context.createMediaStreamSource(new Stream([track]));
      const ended = () => {
        removeExtra();
        onExtraEnded();
      };
      removeExtra();
      stream.getVideoTracks().forEach((video) => {
        video.enabled = false;
      });
      source.connect(extraGain);
      extra = { stream, track, source, ended };
      stream.getTracks().forEach((track) => track.addEventListener('ended', ended, { once: true }));
    },
    removeExtra,
    dispose() {
      if (disposed) return;
      disposed = true;
      removeExtra();
      primarySource?.disconnect();
      primaryTrack?.stop();
      silence.stop();
      silence.disconnect();
      primaryGain.disconnect();
      extraGain.disconnect();
      limiter.disconnect();
      stop(destination.stream);
      context.close().catch(() => {});
    },
  };
}
