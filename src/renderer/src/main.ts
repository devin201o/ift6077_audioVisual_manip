import { encodeFrame, segmentAt, type Mask } from './segmentation';
import { makeCutout, maskBox, objectInput, frameInput, type Cutout, type Prepared, type Src } from './cutout';
import { setupDock } from './dock';
import { setupSettings } from './settings';
import { setupVideo } from './video';
import { setupTimeline } from './timeline';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $('stage'), img = $<HTMLImageElement>('img'), vid = $<HTMLVideoElement>('vid');
const overlay = $<HTMLCanvasElement>('overlay'), bar = $('bar'), statusEl = $('status');
const octx = overlay.getContext('2d')!, pill = $('modepill'), addSel = $('addsel');
const settings = setupSettings();
const dock = setupDock(() => settings.open());
const setStatus = (s: string) => (statusEl.textContent = s);

// ---- state ------------------------------------------------------------------
let kind: 'image' | 'video' | null = null;
let frame: HTMLCanvasElement | null = null; // full-res capture of the current frame
let ready = false; // embedding for the current frame is cached in the main process
let req = 0; // bumped on every pause/seek/play/new file; doubles as the frame ID sent to main. Stale async results compare against it
let modelReady = false;
// Selection: all distinct masks for the last click (small -> large) and which one is shown.
let sel: { masks: Mask[]; level: number } | null = null;
let glow: HTMLCanvasElement | null = null; // pre-rendered glow for the shown mask, in stage CSS px
let dragging = false;
let objectUrl = '';
let curSrc: Src | null = null; // provenance of the open file
let toDock = false; // "+ > Object" mode: the confirmed selection becomes a chip
let lastClick = { x: 0, y: 0 }; // last click in native px: provenance for object chips
let box: ReturnType<typeof maskBox> = null, boxFor: Mask | null = null; // bbox of the shown mask (for the confirm button)

const shown = () => (sel ? sel.masks[sel.level] : null);
const active = () => modelReady && ready && (kind === 'image' || (kind === 'video' && vid.paused));
const updateCursor = () => (overlay.style.cursor = active() ? 'crosshair' : 'default');
const readyText = () => (sel ? `Selected · ${sel.level + 1}/${sel.masks.length}` : 'Ready — click an object');

// ---- geometry: pointer <-> native frame pixels (handles object-fit: contain letterboxing) --------
function geom() {
  const nw = kind === 'video' ? vid.videoWidth : img.naturalWidth;
  const nh = kind === 'video' ? vid.videoHeight : img.naturalHeight;
  const bw = stage.clientWidth, bh = stage.clientHeight;
  const scale = Math.min(bw / nw, bh / nh);
  return { nw, nh, scale, offX: (bw - nw * scale) / 2, offY: (bh - nh * scale) / 2, rect: stage.getBoundingClientRect() };
}
function toNative(e: PointerEvent) {
  const g = geom();
  const x = (e.clientX - g.rect.left - g.offX) / g.scale, y = (e.clientY - g.rect.top - g.offY) / g.scale;
  return { x, y, inside: x >= 0 && y >= 0 && x < g.nw && y < g.nh };
}
const inMask = (m: Mask | null, x: number, y: number) =>
  !!m && x >= 0 && y >= 0 && x < m.width && y < m.height && m.data[Math.floor(y) * m.width + Math.floor(x)] === 1;

// ---- glow ------------------------------------------------------------------------
function buildGlow(m: Mask) {
  const g = geom();
  const dw = Math.round(g.nw * g.scale), dh = Math.round(g.nh * g.scale);
  // native mask -> canvas, then scaled to display size (smoothing antialiases the edge)
  const src = document.createElement('canvas');
  src.width = m.width; src.height = m.height;
  const id = new ImageData(m.width, m.height);
  for (let i = 0; i < m.data.length; i++) if (m.data[i]) id.data[i * 4 + 3] = 255;
  src.getContext('2d')!.putImageData(id, 0, 0);
  const sc = document.createElement('canvas');
  sc.width = dw; sc.height = dh;
  const sctx = sc.getContext('2d', { willReadFrequently: true })!;
  sctx.drawImage(src, 0, 0, dw, dh);
  // edge = mask pixels with a non-mask 4-neighbour
  const a = sctx.getImageData(0, 0, dw, dh).data;
  const edge = new ImageData(dw, dh);
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < dw && y < dh && a[(y * dw + x) * 4 + 3] > 127;
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++)
    if (on(x, y) && !(on(x - 1, y) && on(x + 1, y) && on(x, y - 1) && on(x, y + 1))) edge.data.set([255, 255, 255, 255], (y * dw + x) * 4);
  const ec = document.createElement('canvas');
  ec.width = dw; ec.height = dh;
  ec.getContext('2d')!.putImageData(edge, 0, 0);

  const out = document.createElement('canvas');
  out.width = stage.clientWidth; out.height = stage.clientHeight;
  const c = out.getContext('2d')!;
  c.translate(g.offX, g.offY);
  c.globalAlpha = 0.22; c.drawImage(sc, 0, 0); // fill tint
  c.globalCompositeOperation = 'source-atop'; c.fillStyle = '#3b82ff'; c.fillRect(0, 0, dw, dh);
  c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
  c.shadowColor = '#1f6bff'; c.shadowBlur = 12; // blue halo reads on both dark and white (snow) backgrounds
  c.drawImage(ec, 0, 0); c.drawImage(ec, 0, 0); c.drawImage(ec, 0, 0);
  return out;
}
function render() {
  const dpr = devicePixelRatio || 1;
  const w = stage.clientWidth, h = stage.clientHeight;
  if (overlay.width !== w * dpr || overlay.height !== h * dpr) { overlay.width = w * dpr; overlay.height = h * dpr; }
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.clearRect(0, 0, w, h);
  if (glow && !dragging) octx.drawImage(glow, 0, 0, w, h); // selection stays but is hidden while its cutout is carried
  placeAdd();
}
/** "Add to dock" button just below the selection, kept inside the stage. */
function placeAdd() {
  const m = shown();
  addSel.hidden = !(toDock && m && !dragging);
  if (addSel.hidden) return;
  if (m !== boxFor) { boxFor = m; box = maskBox(m!); }
  if (!box) { addSel.hidden = true; return; }
  const g = geom();
  addSel.style.left = `${Math.min(Math.max(g.offX + ((box.x0 + box.x1 + 1) / 2) * g.scale, 70), stage.clientWidth - 70)}px`;
  addSel.style.top = `${Math.min(g.offY + (box.y1 + 1) * g.scale + 8, stage.clientHeight - 40)}px`;
}
function setMode(on: boolean, note = '') {
  toDock = on;
  pill.hidden = !on;
  pill.textContent = `Selecting for dock${note} — click an object, click again to grow · Enter to add · Esc to exit`;
  render();
}
function setShown() {
  const m = shown();
  glow = m ? buildGlow(m) : null;
  render();
  if (ready) setStatus(readyText());
}
function clearAll() { sel = null; glow = null; render(); }

// ---- embedding lifecycle -----------------------------------------------------------
/** Invalidate everything tied to the previous frame. */
function invalidate(msg: string) {
  req++; ready = false; setMode(false); clearAll(); setStatus(msg); updateCursor();
}
async function prepare() {
  const my = ++req;
  ready = false; clearAll(); updateCursor();
  setStatus(modelReady ? 'Preparing…' : 'Loading model…');
  await modelPromise;
  if (my !== req) return;
  if (!modelReady) return; // error text already shown
  setStatus('Preparing…');
  // capture at native resolution; used for both encoding (main process) and cutouts (here)
  const f = document.createElement('canvas');
  const src = kind === 'video' ? vid : img;
  f.width = kind === 'video' ? vid.videoWidth : img.naturalWidth;
  f.height = kind === 'video' ? vid.videoHeight : img.naturalHeight;
  f.getContext('2d')!.drawImage(src, 0, 0);
  console.log(`[seg] encode req=${my}`);
  const t0 = performance.now();
  const ok = await encodeFrame(my, f);
  console.log(`[seg] encode req=${my} took ${Math.round(performance.now() - t0)}ms`);
  if (my !== req || !ok) { console.log(`[seg] stale req=${my} discarded (now ${req})`); return; }
  frame = f; ready = true;
  setStatus(readyText()); updateCursor();
}

/** One decoder run at a native-pixel point; null if the frame changed meanwhile. */
async function select(p: { x: number; y: number }): Promise<Mask[] | null> {
  const my = req;
  const masks = await segmentAt(my, frame!.width, frame!.height, p.x, p.y);
  return my === req && masks ? masks : null;
}

// ---- pointer: click / cycle / carry ------------------------------------------------
// A press that moves > 4px lifts the cutout as a ghost that follows the pointer. Releasing over the dock adds a chip;
// anywhere else (or Esc) the ghost flies back and vanishes. The selection stays in every case.
// No pointermove handling outside a press: moving over the frame does nothing.
type Down = { sx: number; sy: number; lx: number; ly: number; p: { x: number; y: number; inside: boolean }; lifted: boolean; ended: boolean; cancelled: boolean; expanded: boolean; cut?: Cutout; make?: () => Promise<Prepared>; ghost?: HTMLImageElement; baseL: number; baseT: number };
let down: Down | null = null;

overlay.addEventListener('pointerdown', (e) => {
  if (!active() || e.button !== 0) return;
  const p = toNative(e);
  e.preventDefault();
  try { overlay.setPointerCapture(e.pointerId); } catch { /* window listeners cover this */ }
  down = { sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, p, lifted: false, ended: false, cancelled: false, expanded: false, baseL: 0, baseT: 0 };
});
// Move/up are listened on window, not just the overlay: the drag must keep working when the pointer leaves the
// stage (setPointerCapture is also set, but window listeners make it independent of capture behaviour).
window.addEventListener('pointermove', (e) => {
  if (!down || !active()) return;
  down.lx = e.clientX; down.ly = e.clientY;
  if (!down.lifted && down.p.inside && Math.hypot(e.clientX - down.sx, e.clientY - down.sy) > 4) lift(down);
  if (down.ghost) {
    moveGhost(down);
    const over = dock.hit(down.lx, down.ly);
    if (over && dock.collapsed()) { dock.expand(); down.expanded = true; }
    dock.setHot(over);
  }
});

function moveGhost(d: Down) {
  d.ghost!.style.left = `${d.baseL + d.lx - d.sx}px`;
  d.ghost!.style.top = `${d.baseT + d.ly - d.sy}px`;
}
function stopCarry() { dragging = false; render(); }

async function lift(d: Down) {
  d.lifted = true; dragging = true;
  // pressing outside the selection first selects the object under the press (smallest level)
  if (!inMask(shown(), d.p.x, d.p.y)) {
    const masks = await select(d.p);
    if (!masks) return stopCarry(); // stale
    sel = masks.length ? { masks, level: 0 } : null;
    setShown();
    if (!sel) return stopCarry(); // nothing found: no lift
  }
  lastClick = d.p;
  const fr = frame!, mask = shown()!, time = kind === 'video' ? vid.currentTime : null, src = curSrc!;
  const c = await makeCutout(fr, mask);
  if (!c || d.cancelled) return stopCarry();
  const g = geom();
  d.cut = c;
  d.make = () => objectInput(fr, mask, c, { x: d.p.x / fr.width, y: d.p.y / fr.height }, time, src); // taken now: the frame may change before release
  d.baseL = g.rect.left + g.offX + c.x * g.scale;
  d.baseT = g.rect.top + g.offY + c.y * g.scale;
  const ghost = document.createElement('img');
  ghost.src = URL.createObjectURL(c.blob); ghost.className = 'ghost';
  ghost.style.width = `${c.w * g.scale}px`; ghost.style.height = `${c.h * g.scale}px`;
  document.body.appendChild(ghost);
  d.ghost = ghost;
  moveGhost(d);
  render(); // hide the glow while carried
  if (d.ended) release(d, d.cancelled); // pointer was released while the cutout was still being built
}

async function release(d: Down, cancel: boolean) {
  const ghost = d.ghost!, c = d.cut!;
  stopCarry();
  const over = !cancel && dock.hit(d.lx, d.ly);
  dock.setHot(false);
  let anim: Animation;
  if (over) {
    const a = ghost.getBoundingClientRect(), r = dock.rect();
    dock.submit('Object', d.make!);
    anim = ghost.animate([{ transform: 'scale(1.06)', opacity: 1 }, { transform: `translate(${r.left + r.width / 2 - a.left - a.width / 2}px, ${r.top + r.height / 2 - a.top - a.height / 2}px) scale(.1)`, opacity: 0 }], { duration: 150, easing: 'ease-in' });
  } else {
    if (d.expanded) dock.collapse();
    const g = geom(); // recompute: collapsing the dock resizes the stage
    anim = ghost.animate([{ opacity: 1 }, { left: `${g.rect.left + g.offX + c.x * g.scale}px`, top: `${g.rect.top + g.offY + c.y * g.scale}px`, width: `${c.w * g.scale}px`, height: `${c.h * g.scale}px`, opacity: 0 }], { duration: 180, easing: 'ease-out' });
  }
  await anim.finished.catch(() => {});
  URL.revokeObjectURL(ghost.src); ghost.remove();
  if (ready) setStatus(readyText());
}

async function click(p: { x: number; y: number; inside: boolean }) {
  lastClick = p;
  if (!p.inside) { sel = null; setShown(); return; } // letterbox/background: clear
  if (inMask(shown(), p.x, p.y)) { // inside current selection: next larger level, no decoder run
    sel!.level = (sel!.level + 1) % sel!.masks.length;
    setShown();
    return;
  }
  const masks = await select(p);
  if (!masks) return; // stale
  sel = masks.length ? { masks, level: 0 } : null; // nothing useful -> clear
  setShown();
}

function end(e: PointerEvent) {
  if (!down) return;
  const d = down; down = null; d.ended = true;
  d.lx = e.clientX; d.ly = e.clientY;
  if (e.type === 'pointercancel') d.cancelled = true;
  try { overlay.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
  if (d.ghost) release(d, d.cancelled);
  else if (!d.lifted) { if (e.type === 'pointerup' && active()) click(d.p); } // under 4px: a click
  // else: lift() is still working and will release when the ghost exists
}
window.addEventListener('pointerup', end);
window.addEventListener('pointercancel', end);
overlay.addEventListener('contextmenu', (e) => e.preventDefault());

// ---- "+" menu: chips from the player -------------------------------------------------
const time = () => (kind === 'video' ? vid.currentTime : null);

/** Grab the frame being shown. While playing, take the next presented frame and its own timestamp (no pause needed). */
function grabVideo(): Promise<{ canvas: HTMLCanvasElement; t: number }> {
  return new Promise((res) => {
    let done = false;
    const cap = (t: number) => {
      if (done) return; done = true;
      const c = document.createElement('canvas');
      c.width = vid.videoWidth; c.height = vid.videoHeight;
      c.getContext('2d')!.drawImage(vid, 0, 0);
      res({ canvas: c, t });
    };
    if (vid.paused) return cap(vid.currentTime);
    vid.requestVideoFrameCallback((_now, md) => cap(md.mediaTime));
    setTimeout(() => cap(vid.currentTime), 300); // video paused/ended before another frame was presented
  });
}
function addWholeFrame() {
  if (!kind || !curSrc) return;
  const src = curSrc, isVideo = kind === 'video', img0 = img;
  dock.submit('Frame', async () => {
    if (isVideo) { const g = await grabVideo(); return frameInput(g.canvas, g.t, src); }
    const c = document.createElement('canvas');
    c.width = img0.naturalWidth; c.height = img0.naturalHeight;
    c.getContext('2d')!.drawImage(img0, 0, 0);
    return frameInput(c, null, src);
  });
}
function startObjectMode() {
  if (!kind) return;
  if (!modelReady) { setStatus('Segmentation model is not ready'); return; }
  const wasPlaying = kind === 'video' && !vid.paused;
  if (wasPlaying) vid.pause(); // SAM needs a still frame
  setMode(true, wasPlaying ? ' (video paused)' : '');
}
function addSelection() {
  const mask = shown(), fr = frame;
  if (!mask || !fr || !curSrc) return;
  const src = curSrc, t = time(), pt = { x: lastClick.x / fr.width, y: lastClick.y / fr.height };
  dock.submit('Object', async () => {
    const c = await makeCutout(fr, mask);
    if (!c) throw new Error('empty mask');
    return objectInput(fr, mask, c, pt, t, src);
  });
  setMode(false); // selection stays
}
addSel.addEventListener('click', addSelection);
window.addEventListener('online', () => window.lib.retryNetwork()); // chips that failed only for lack of network
dock.setMenu([{ label: 'Whole frame', run: addWholeFrame }, { label: 'Object', run: startObjectMode }]);

// ---- video ---------------------------------------------------------------------------
const tl = setupTimeline($('timeline'), vid);
const vctl = setupVideo(vid, bar, {
  onTick: () => tl.update(),
  onBusy: () => invalidate(vid.paused ? 'Seeking…' : 'Playing'),
  onFrameReady: () => { if (kind === 'video') prepare(); },
  isDragging: () => dragging,
});
window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('dialog')) return; // dialogs own their keys
  if ((e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'range') return;
  if (e.key === 'Escape') {
    const d = down;
    if (d?.lifted) { d.cancelled = true; if (d.ghost) { down = null; release(d, true); } } // cancel the carry; selection stays
    else if (!sel && toDock) setMode(false);
    else { sel = null; setShown(); }
    return;
  }
  if (e.key === 'Enter' && toDock && shown()) { e.preventDefault(); addSelection(); return; }
  if (kind === 'video' && vctl.key(e)) e.preventDefault();
});
// arrows are 10s skips, not slider nudges (volume slider is the only range input left)
$('vol').addEventListener('keydown', (e) => { if (e.key.startsWith('Arrow')) e.preventDefault(); });

// ---- loading files -----------------------------------------------------------------------
function openFile(file: File) {
  const isVideo = file.type.startsWith('video/'), isImage = file.type.startsWith('image/');
  if (!isVideo && !isImage) return;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file); // local only, never uploaded
  invalidate('Loading…');
  curSrc = { path: window.lib.pathFor(file) || null, name: file.name, media: isVideo ? 'video' : 'image' };
  vid.pause(); vid.removeAttribute('src'); img.removeAttribute('src');
  kind = isVideo ? 'video' : 'image';
  $('hint').hidden = true; stage.hidden = false; dock.setPlusEnabled(true);
  img.hidden = isVideo; vid.hidden = !isVideo; bar.hidden = !isVideo; $('timeline').hidden = !isVideo;
  if (isVideo) {
    vid.src = objectUrl;
    tl.load(file, objectUrl);
    vid.addEventListener('loadeddata', () => { vctl.update(); prepare(); }, { once: true });
  } else {
    img.onload = () => prepare();
    img.src = objectUrl;
  }
}
$<HTMLInputElement>('file').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0]; if (f) openFile(f);
});
document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('over'); });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) { document.body.classList.remove('over'); dock.restore(); } });
document.addEventListener('drop', (e) => {
  e.preventDefault(); document.body.classList.remove('over');
  const f = e.dataTransfer?.files[0]; if (f) openFile(f);
});
window.addEventListener('resize', () => { glow = shown() ? buildGlow(shown()!) : null; render(); });

// ---- boot --------------------------------------------------------------------------------
const modelPromise = window.sam.status().then((st) => {
  modelReady = st.ready;
  if (st.ready) setStatus(kind ? 'Preparing…' : `Model ready (${st.ep}) — add an image or video`);
  else setStatus(st.missing ? 'SAM 2.1 model files missing. Run: npm run fetch-models' : (st.error ?? 'Model failed to load'));
});
(window as any).__dbg = { get req() { return req; }, get ready() { return ready; }, get sel() { return sel && { level: sel.level, n: sel.masks.length }; }, vid };
