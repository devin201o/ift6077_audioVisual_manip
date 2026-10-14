export const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export interface VideoHooks {
  /** playing or seeking: clear everything, ignore pointer */
  onBusy(): void;
  /** paused and seek finished (debounced) */
  onFrameReady(): void;
  /** true while a cutout is being dragged: playback keys are ignored */
  isDragging(): boolean;
  /** time/position changed (every animation frame while playing) */
  onTick?(): void;
}

export function setupVideo(video: HTMLVideoElement, bar: HTMLElement, hooks: VideoHooks) {
  const $ = (s: string) => bar.querySelector(s) as HTMLElement;
  const playBtn = $('#play'), time = $('#time');
  let timer: number | undefined;

  const settle = () => {
    clearTimeout(timer);
    // video.seeking covers the case where another seek started during the debounce
    timer = window.setTimeout(() => { if (video.paused && !video.seeking) hooks.onFrameReady(); }, 150);
  };
  const busy = () => { clearTimeout(timer); hooks.onBusy(); };
  const update = () => {
    playBtn.textContent = video.paused ? '▶' : '❚❚';
    time.textContent = `${fmt(video.currentTime)} / ${fmt(video.duration || 0)}`;
    hooks.onTick?.();
  };
  // timeupdate only fires ~4x/s; drive the playhead per frame while playing
  let looping = false;
  const raf = () => {
    update();
    if (!video.paused && !video.ended) requestAnimationFrame(raf); else looping = false;
  };

  video.addEventListener('play', () => { busy(); update(); if (!looping) { looping = true; raf(); } });
  video.addEventListener('pause', () => { update(); settle(); });
  video.addEventListener('seeking', busy);
  video.addEventListener('seeked', settle);
  video.addEventListener('timeupdate', update);
  video.addEventListener('loadedmetadata', () => { update(); });
  video.addEventListener('ended', () => { update(); settle(); });

  const toggle = () => (video.paused ? video.play() : video.pause());
  const skip = (d: number) => { video.currentTime = Math.min(Math.max(video.currentTime + d, 0), video.duration || 0); };
  // Frame rate isn't exposed by <video>; assume 30fps.
  const step = (d: number) => { if (video.paused) skip(d / 30); };

  const muteBtn = $('#mute'), vol = $('#vol') as HTMLInputElement;
  const toggleMute = () => (video.muted = !video.muted);
  video.addEventListener('volumechange', () => {
    const silent = video.muted || video.volume === 0;
    muteBtn.textContent = silent ? '🔇' : '🔊';
    vol.value = String(video.muted ? 0 : video.volume);
  });
  muteBtn.onclick = toggleMute;
  vol.addEventListener('input', () => { video.volume = +vol.value; video.muted = video.volume === 0; });

  playBtn.onclick = toggle;
  $('#back').onclick = () => skip(-10);
  $('#fwd').onclick = () => skip(10);

  return {
    key(e: KeyboardEvent): boolean {
      if (video.hidden || hooks.isDragging()) return false;
      const k = e.key;
      if (k === ' ') toggle();
      else if (k === 'ArrowLeft') skip(-10);
      else if (k === 'ArrowRight') skip(10);
      else if (k === ',') step(-1);
      else if (k === '.') step(1);
      else if (k === 'm' || k === 'M') toggleMute();
      else return false;
      return true;
    },
    update,
  };
}
