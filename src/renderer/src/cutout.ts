import type { Mask } from './segmentation';

export interface Cutout { blob: Blob; x: number; y: number; w: number; h: number } // bbox in native px

/** Transparent PNG of the frame, cropped to the mask bbox, mask edge feathered ~1px. */
export async function makeCutout(frame: HTMLCanvasElement, mask: Mask): Promise<Cutout | null> {
  const { data, width: mw, height: mh } = mask;
  let x0 = mw, y0 = mh, x1 = -1, y1 = -1;
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
    if (!data[y * mw + x]) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y;
  }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1, pad = 2; // pad so the blur isn't clipped at the bbox

  const m = new ImageData(w + pad * 2, h + pad * 2);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
    if (data[(y + y0) * mw + x + x0]) m.data[((y + pad) * m.width + x + pad) * 4 + 3] = 255;
  const maskCv = new OffscreenCanvas(m.width, m.height);
  maskCv.getContext('2d')!.putImageData(m, 0, 0);

  const out = document.createElement('canvas');
  out.width = m.width; out.height = m.height;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(frame, x0 - pad, y0 - pad, out.width, out.height, 0, 0, out.width, out.height);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.filter = 'blur(1px)';
  ctx.drawImage(maskCv, 0, 0);
  const blob = await new Promise<Blob>((r) => out.toBlob((b) => r(b!), 'image/png'));
  return { blob, x: x0 - pad, y: y0 - pad, w: out.width, h: out.height };
}

// --- floating layers -------------------------------------------------------

const layers = new Set<HTMLImageElement>();
let layerDragging = false;
export const isLayerDragging = () => layerDragging;

/**
 * A dropped cutout. Plain drag repositions it inside the window (pointer events).
 * Option-drag starts a native OS drag through the main process (temp PNG file), so it can be dropped into Finder etc.
 * Note: a native drag can only start from a dragstart gesture, so a plain drag that leaves the window cannot be
 * converted into a native drag mid-gesture.
 */
export function addLayer(c: Cutout, left: number, top: number, width: number, height: number) {
  const img = document.createElement('img');
  const url = URL.createObjectURL(c.blob);
  img.src = url;
  img.className = 'cutout';
  img.draggable = true; // native drag only starts for Option-drags; plain presses preventDefault below
  Object.assign(img.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
  document.body.appendChild(img);
  layers.add(img);

  let fileId: number | undefined;
  c.blob.arrayBuffer().then((buf) => window.sam.saveCutout(buf)).then((id) => (fileId = id));

  img.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.altKey) return; // Option: let the browser fire dragstart -> native OS drag
    e.preventDefault(); // suppresses the compat mousedown, so no native drag starts
    try { img.setPointerCapture(e.pointerId); } catch { /* window listeners cover this */ }
    layerDragging = true;
    img.classList.add('lifting');
    const dx = e.clientX - img.offsetLeft, dy = e.clientY - img.offsetTop;
    const move = (m: PointerEvent) => { img.style.left = `${m.clientX - dx}px`; img.style.top = `${m.clientY - dy}px`; };
    const up = () => {
      layerDragging = false;
      img.classList.remove('lifting');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
  img.addEventListener('dragstart', (e) => {
    e.preventDefault(); // hand over to Electron's native drag
    if (fileId !== undefined) window.sam.startDrag(fileId);
  });
  return img;
}

export function clearLayers() {
  for (const l of layers) { URL.revokeObjectURL(l.src); l.remove(); }
  layers.clear();
  window.sam.clearCutouts();
}
