import { fmt } from './video';

const RULER_H = 18, STRIP_H = 56, WAVE_H = 48;

/** Resolves on `ev` or on `error`, so a broken media element can't hang the build. */
const once = (el: HTMLMediaElement, ev: string) =>
  new Promise<void>((r) => { el.addEventListener(ev, () => r(), { once: true }); el.addEventListener('error', () => r(), { once: true }); });

/** Read-only timeline: ruler, frame filmstrip, audio waveform, playhead. Click/drag seeks `video`. */
export function setupTimeline(root: HTMLElement, video: HTMLVideoElement) {
  const q = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
  const ruler = q<HTMLCanvasElement>('#ruler'), strip = q<HTMLCanvasElement>('#strip');
  const waveCanvas = q<HTMLCanvasElement>('#wave canvas'), noAudio = q('#noaudio'), playhead = q('#playhead');
  let gen = 0; // bumped per file; in-flight builds for an older file stop drawing
  let rulerDur = -1;

  /** Size the canvas for the current track width and return a CSS-pixel context (also clears it). */
  const size = (c: HTMLCanvasElement, h: number) => {
    const dpr = devicePixelRatio || 1;
    c.width = root.clientWidth * dpr; c.height = h * dpr;
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    return ctx;
  };

  function drawRuler() {
    const dur = video.duration, w = root.clientWidth;
    const c = size(ruler, RULER_H);
    if (!dur) return;
    const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => (s / dur) * w >= 60) ?? 600;
    c.fillStyle = '#8e8e93'; c.font = '10px -apple-system, system-ui, sans-serif';
    for (let t = 0; t <= dur; t += step) {
      const x = (t / dur) * w;
      c.fillRect(x, 10, 1, 8);
      c.fillText(fmt(t), Math.max(x + 3, 6), 9); // keep the 0:00 label off the left edge
    }
  }

  // ponytail: strip is built once at the width the file was opened at; CSS stretches it on resize. Rebuild on resize if distortion bothers.
  async function buildStrip(url: string, g: number) {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.src = url;
    await once(v, 'loadedmetadata');
    if (g !== gen || !v.videoHeight) return;
    const w = root.clientWidth, thumbW = Math.round((STRIP_H * v.videoWidth) / v.videoHeight);
    const n = Math.max(1, Math.ceil(w / thumbW)), c = size(strip, STRIP_H);
    for (let i = 0; i < n && g === gen; i++) {
      v.currentTime = ((i + 0.5) / n) * v.duration;
      await once(v, 'seeked');
      if (g === gen) c.drawImage(v, (i * w) / n, 0, w / n + 1, STRIP_H); // +1 hides hairline gaps
    }
    v.removeAttribute('src'); v.load();
  }

  // ponytail: decodeAudioData holds the whole PCM in memory (~230 MB for 10 min stereo 48 kHz). Chunked decode if long files matter.
  async function buildWave(file: File, g: number) {
    const c = size(waveCanvas, WAVE_H);
    noAudio.hidden = true;
    const ac = new AudioContext();
    let buf: AudioBuffer;
    try { buf = await ac.decodeAudioData(await file.arrayBuffer()); }
    catch { if (g === gen) noAudio.hidden = false; return; } // no audio track / undecodable
    finally { ac.close(); }
    if (g !== gen) return;
    const w = root.clientWidth, chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
    const per = buf.length / w, stride = Math.max(1, Math.floor(per / 200));
    c.fillStyle = '#6ea8ff';
    for (let x = 0; x < w; x++) {
      let peak = 0;
      for (let i = Math.floor(x * per), end = Math.floor((x + 1) * per); i < end; i += stride)
        for (const d of chans) peak = Math.max(peak, Math.abs(d[i]));
      const h = Math.max(1, peak * WAVE_H);
      c.fillRect(x, (WAVE_H - h) / 2, 1, h);
    }
  }

  // While dragging, the playhead follows the pointer (scrubT) and seeks are coalesced: at most one in flight,
  // and when it lands we jump straight to the newest target, skipping the ones in between.
  let scrubT: number | null = null, pending: number | null = null;
  const pump = () => {
    if (pending !== null && !video.seeking) { video.currentTime = pending; pending = null; }
  };
  video.addEventListener('seeked', pump);

  function update() {
    const dur = video.duration;
    playhead.style.left = dur ? `${((scrubT ?? video.currentTime) / dur) * 100}%` : '0';
    if (dur !== rulerDur) { rulerDur = dur; drawRuler(); }
  }

  const seekTo = (e: PointerEvent) => {
    const r = root.getBoundingClientRect();
    if (!video.duration) return;
    scrubT = pending = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1) * video.duration;
    update(); pump();
  };
  let drag = false;
  root.addEventListener('pointerdown', (e) => { drag = true; root.setPointerCapture(e.pointerId); seekTo(e); });
  root.addEventListener('pointermove', (e) => { if (drag) seekTo(e); });
  const release = () => { drag = false; scrubT = null; update(); };
  root.addEventListener('pointerup', release);
  root.addEventListener('pointercancel', release);
  window.addEventListener('resize', () => { rulerDur = -1; update(); });

  return {
    load(file: File, url: string) {
      const g = ++gen;
      rulerDur = -1; drawRuler(); size(strip, STRIP_H);
      buildStrip(url, g); buildWave(file, g);
    },
    update,
  };
}
