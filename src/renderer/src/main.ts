import { encodeFrame, segmentAt, type Mask } from './segmentation';
import { makeCutout, addLayer, clearLayers, isLayerDragging } from './cutout';
import { setupVideo } from './video';
import { setupTimeline } from './timeline';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $('stage'), img = $<HTMLImageElement>('img'), vid = $<HTMLVideoElement>('vid');
const overlay = $<HTMLCanvasElement>('overlay'), bar = $('bar'), statusEl = $('status');
const octx = overlay.getContext('2d')!;
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
  if (glow) octx.drawImage(glow, 0, 0, w, h);
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
  req++; ready = false; clearAll(); setStatus(msg); updateCursor();
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

// ---- pointer: click / cycle / lift -------------------------------------------------
// No pointermove handling outside a press: moving over the frame does nothing.
type Down = { sx: number; sy: number; lx: number; ly: number; p: { x: number; y: number; inside: boolean }; lifted: boolean; ended: boolean; layer?: HTMLImageElement; baseL: number; baseT: number };
let down: Down | null = null;

overlay.addEventListener('pointerdown', (e) => {
  if (!active() || e.button !== 0) return;
  e.preventDefault();
  try { overlay.setPointerCapture(e.pointerId); } catch { /* window listeners cover this */ }
  down = { sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, p: toNative(e), lifted: false, ended: false, baseL: 0, baseT: 0 };
});
// Move/up are listened on window, not just the overlay: the drag must keep working when the pointer leaves the
// stage (setPointerCapture is also set, but window listeners make it independent of capture behaviour).
window.addEventListener('pointermove', (e) => {
  if (!down || !active()) return;
  down.lx = e.clientX; down.ly = e.clientY;
  if (!down.lifted && down.p.inside && Math.hypot(e.clientX - down.sx, e.clientY - down.sy) > 4) lift(down);
  if (down.layer) moveLayer(down);
});

function moveLayer(d: Down) {
  d.layer!.style.left = `${d.baseL + d.lx - d.sx}px`;
  d.layer!.style.top = `${d.baseT + d.ly - d.sy}px`;
}

async function lift(d: Down) {
  d.lifted = true; dragging = true;
  // pressing outside the selection first selects the object under the press (smallest level)
  if (!inMask(shown(), d.p.x, d.p.y)) {
    const masks = await select(d.p);
    if (!masks) { dragging = false; return; } // stale
    sel = masks.length ? { masks, level: 0 } : null;
    setShown();
    if (!sel) { dragging = false; return; } // nothing found: no lift
  }
  const c = await makeCutout(frame!, shown()!);
  if (!c) { dragging = false; return; }
  const g = geom();
  d.baseL = g.rect.left + g.offX + c.x * g.scale;
  d.baseT = g.rect.top + g.offY + c.y * g.scale;
  d.layer = addLayer(c, d.baseL, d.baseT, c.w * g.scale, c.h * g.scale);
  d.layer.classList.add('lifting');
  moveLayer(d);
  sel = null; glow = null; render(); // object is "picked up": selection goes away
  if (d.ended) finish(d); // pointer was released while the cutout was still being built
}
function finish(d: Down) {
  dragging = false;
  d.layer?.classList.remove('lifting');
  if (ready) setStatus(readyText());
}

async function click(p: { x: number; y: number; inside: boolean }) {
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
  try { overlay.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
  if (d.layer) { moveLayer(d); finish(d); }
  else if (!d.lifted) { if (e.type === 'pointerup' && active()) click(d.p); } // under 4px: a click
  // else: lift() is still working and will call finish()
}
window.addEventListener('pointerup', end);
window.addEventListener('pointercancel', end);
overlay.addEventListener('dragstart', (e) => e.preventDefault());
overlay.addEventListener('contextmenu', (e) => e.preventDefault());

// ---- video ---------------------------------------------------------------------------
const tl = setupTimeline($('timeline'), vid);
const vctl = setupVideo(vid, bar, {
  onTick: () => tl.update(),
  onBusy: () => invalidate(vid.paused ? 'Seeking…' : 'Playing'),
  onFrameReady: () => { if (kind === 'video') prepare(); },
  isDragging: () => dragging || isLayerDragging(),
});
window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'range') return;
  if (e.key === 'Escape') { if (!dragging) { sel = null; setShown(); } return; }
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
  vid.pause(); vid.removeAttribute('src'); img.removeAttribute('src');
  kind = isVideo ? 'video' : 'image';
  $('hint').hidden = true; stage.hidden = false;
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
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('over'); });
document.addEventListener('drop', (e) => {
  e.preventDefault(); document.body.classList.remove('over');
  const f = e.dataTransfer?.files[0]; if (f) openFile(f);
});
$('clear').onclick = clearLayers;
window.addEventListener('resize', () => { glow = shown() ? buildGlow(shown()!) : null; render(); });

// ---- boot --------------------------------------------------------------------------------
const modelPromise = window.sam.status().then((st) => {
  modelReady = st.ready;
  if (st.ready) setStatus(kind ? 'Preparing…' : `Model ready (${st.ep}) — add an image or video`);
  else setStatus(st.missing ? 'SAM 2.1 model files missing. Run: npm run fetch-models' : (st.error ?? 'Model failed to load'));
});
(window as any).__dbg = { get req() { return req; }, get ready() { return ready; }, get sel() { return sel && { level: sel.level, n: sel.masks.length }; }, vid };
