let context;
const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export function setPlaybackVolume(tile, value) {
  tile.playbackVolume = Math.max(0, Math.min(1, Number(value) || 0));
  const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (isIOS() && Audio) {
    try {
      context ??= new Audio();
      if (!tile.audioGain) {
        const source = context.createMediaElementSource(tile.audio),
          gain = context.createGain();
        source.connect(gain);
        gain.connect(context.destination);
        tile.audioSource = source;
        tile.audioGain = gain;
        tile.audio.addEventListener('volumechange', () => {
          if (tile.audioGain)
            tile.audioGain.gain.value = tile.audio.muted ? 0 : tile.playbackVolume;
        });
      }
      tile.audio.volume = 1;
      tile.audioGain.gain.value = tile.audio.muted ? 0 : tile.playbackVolume;
      return;
    } catch {}
  }
  tile.audio.volume = tile.playbackVolume;
}
export function resumePlayback() {
  if (context?.state === 'suspended') context.resume().catch(() => {});
}
export function releasePlayback(tile) {
  try {
    tile.audioSource?.disconnect();
    tile.audioGain?.disconnect();
  } catch {}
}
