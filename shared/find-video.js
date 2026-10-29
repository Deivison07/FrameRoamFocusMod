(() => {
function findBestVideo() {
  const candidates = [...document.querySelectorAll('video')].map((video, index) => {
    const rect = video.getBoundingClientRect();
    return {
      index,
      playing: !video.paused && !video.ended,
      ready: video.readyState > 0,
      area: Math.max(0, rect.width) * Math.max(0, rect.height),
      playbackLimited: Boolean(video.error) || (video.networkState === 3 && video.readyState === 0)
    };
  });
  candidates.sort((a, b) => Number(b.playing) - Number(a.playing)
    || Number(b.ready) - Number(a.ready) || b.area - a.area);
  return candidates[0] ?? null;
}

globalThis.VideoControllerShared = Object.freeze({ findBestVideo });
})();
