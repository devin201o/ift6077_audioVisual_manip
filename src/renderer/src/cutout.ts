import type { Mask } from './segmentation';
import type { AddInput } from '../../shared/chip';
import { once } from './timeline';

export interface Cutout { blob: Blob; x: number; y: number; w: number; h: number } // bbox in native px

/** Bounding box (inclusive) and pixel count of a mask; null if empty. */
export function maskBox({ data, width: mw, height: mh }: Mask) {
  let x0 = mw, y0 = mh, x1 = -1, y1 = -1, count = 0;
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
    if (!data[y * mw + x]) continue;
    count++;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y;
  }
  return x1 < 0 ? null : { x0, y0, x1, y1, count };
}

/** Transparent PNG of the frame, cropped to the mask bbox, mask edge feathered ~1px. */
export async function makeCutout(frame: HTMLCanvasElement, mask: Mask): Promise<Cutout | null> {
  const box = maskBox(mask);
  if (!box) return null;
  const { data, width: mw } = mask;
  const { x0, y0 } = box;
  const w = box.x1 - x0 + 1, h = box.y1 - y0 + 1, pad = 2; // pad so the blur isn't clipped at the bbox

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

/** Scale any drawable so its long edge is at most `long` px (never upscales) and encode it. */
export function downscale(src: CanvasImageSource, w: number, h: number, long: number, type = 'image/webp', q = 0.85): Promise<Blob> {
  const s = Math.min(1, long / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob((b) => r(b!), type, q));
}

// ---- chip inputs: the one place that turns media into an AddInput (thumbnail + images to upload) ------------------
export interface Prepared { input: AddInput; thumb: Blob }
export interface Src { path: string | null; name: string; media: 'image' | 'video' }

const THUMB = 256, UPLOAD = 1024; // plumbing only: no image analysis happens locally
const buf = (b: Blob) => b.arrayBuffer();
const px = (v: CanvasImageSource & { width?: number }, w: number, h: number, long: number) => downscale(v, w, h, long);

/** Cutout + its mask, bbox and the full scene. Dropping a selection on the dock and "+ > Object" both land here. */
export async function objectInput(frame: HTMLCanvasElement, mask: Mask, c: Cutout, click: { x: number; y: number }, frameTime: number | null, src: Src): Promise<Prepared> {
  const box = maskBox(mask)!, { width: w, height: h } = frame;
  const bm = await createImageBitmap(c.blob);
  const mc = new OffscreenCanvas(mask.width, mask.height), id = new ImageData(mask.width, mask.height);
  for (let i = 0; i < mask.data.length; i++) id.data.set(mask.data[i] ? [255, 255, 255, 255] : [0, 0, 0, 255], i * 4);
  mc.getContext('2d')!.putImageData(id, 0, 0);
  const [thumb, obj, scene, maskPng] = await Promise.all([px(bm, bm.width, bm.height, THUMB), px(bm, bm.width, bm.height, UPLOAD), px(frame, w, h, UPLOAD), mc.convertToBlob({ type: 'image/png' })]);
  return {
    thumb,
    input: {
      kind: 'object', source: { ...src, frameTime, click, w, h },
      object: { bbox: { x: box.x0 / w, y: box.y0 / h, w: (box.x1 - box.x0 + 1) / w, h: (box.y1 - box.y0 + 1) / h }, area: box.count / (w * h) },
      thumb: await buf(thumb), cutout: await buf(c.blob), mask: await buf(maskPng), uploads: [await buf(obj), await buf(scene)],
    },
  };
}

/** A whole frame (video at frameTime, or an image with frameTime null). */
export async function frameInput(frame: HTMLCanvasElement, frameTime: number | null, src: Src): Promise<Prepared> {
  const { width: w, height: h } = frame;
  const [thumb, up] = await Promise.all([px(frame, w, h, THUMB), px(frame, w, h, UPLOAD)]);
  return { thumb, input: { kind: 'image', source: { ...src, frameTime, click: null, w, h }, object: null, thumb: await buf(thumb), uploads: [await buf(up)] } };
}

/** A dropped file: an image, or a video as a clip with 3 frames (10/50/90 %). */
export async function fileInput(file: File, path: string): Promise<Prepared> {
  const src: Src = { path: path || null, name: file.name, media: file.type.startsWith('video/') ? 'video' : 'image' };
  if (src.media === 'image') {
    const b = await createImageBitmap(file);
    const [thumb, up] = await Promise.all([px(b, b.width, b.height, THUMB), px(b, b.width, b.height, UPLOAD)]);
    return { thumb, input: { kind: 'image', source: { ...src, frameTime: null, click: null, w: b.width, h: b.height }, object: null, thumb: await buf(thumb), uploads: [await buf(up)] } };
  }
  const v = document.createElement('video'), url = URL.createObjectURL(file);
  v.muted = true; v.preload = 'auto'; v.src = url;
  try {
    await once(v, 'loadeddata');
    if (!v.videoWidth) throw new Error('unplayable video');
    const ups: Blob[] = [];
    for (const f of [0.1, 0.5, 0.9]) {
      if (v.duration) { v.currentTime = v.duration * f; await once(v, 'seeked'); }
      ups.push(await px(v, v.videoWidth, v.videoHeight, UPLOAD));
    }
    const thumb = await createImageBitmap(ups[0]).then((b) => px(b, b.width, b.height, THUMB));
    return {
      thumb,
      input: { kind: 'clip', source: { ...src, frameTime: null, click: null, w: v.videoWidth, h: v.videoHeight }, object: null, thumb: await buf(thumb), uploads: await Promise.all(ups.map(buf)) },
    };
  } finally { v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); }
}
