// Renderer side of segmentation: talks to the main process over IPC and turns the decoder's low-res
// logits into full-resolution masks, de-duplicated and sorted by area (the "levels" used for cycling).
export interface Mask { data: Uint8Array; width: number; height: number }

const M = 256; // decoder mask resolution (covers the whole frame, stretched)
let debug = false;
window.sam.debug().then((d) => (debug = d));

/** Send the full-resolution frame to main, which preprocesses it and caches the embedding under frameId. */
export async function encodeFrame(frameId: number, frame: HTMLCanvasElement): Promise<boolean> {
  const { width: w, height: h } = frame;
  const px = frame.getContext('2d')!.getImageData(0, 0, w, h).data;
  const r = await window.sam.encode(frameId, px, w, h);
  return r.ok;
}

/** Decoder-only call at a native-pixel point. Returns masks smallest -> largest, or [] if nothing useful. */
export async function segmentAt(frameId: number, w: number, h: number, x: number, y: number): Promise<Mask[] | null> {
  const r = await window.sam.decode(frameId, x, y, w, h);
  if (r.stale || !r.logits) return null; // frame changed; caller discards
  if ((r.objectScore ?? 0) < 0) { if (debug) console.log('[seg] no object at point, objectScore', r.objectScore); return []; }

  const n = r.n!;
  // 1. binarise each 256x256 logit map (logit > 0), drop empties
  const cand: { bin: Uint8Array; area: number; k: number }[] = [];
  for (let k = 0; k < n; k++) {
    const bin = new Uint8Array(M * M);
    let area = 0;
    for (let i = 0; i < M * M; i++) if (r.logits[k * M * M + i] > 0) { bin[i] = 1; area++; }
    if (area > 0) cand.push({ bin, area, k });
  }
  // 2. sort by area ascending, then drop near-duplicates (IoU > 0.95) so cycling never lands on a no-op
  cand.sort((a, b) => a.area - b.area);
  const kept: typeof cand = [];
  for (const c of cand) {
    if (!kept.some((o) => iou(o.bin, o.area, c.bin, c.area) > 0.95)) kept.push(c);
  }
  if (debug) console.log('[seg] masks', kept.map((c) => ({ level: kept.indexOf(c) + 1, areaPct: +((c.area / (M * M)) * 100).toFixed(1), score: +r.scores![c.k].toFixed(3) })));
  return kept.map((c) => upscale(r.logits!, c.k, w, h));
}

function iou(a: Uint8Array, areaA: number, b: Uint8Array, areaB: number) {
  let inter = 0;
  for (let i = 0; i < a.length; i++) if (a[i] & b[i]) inter++;
  return inter / (areaA + areaB - inter);
}

/** 256x256 logits -> native-resolution binary mask. Bilinear upscale of a soft alpha keeps edges smooth. */
function upscale(logits: Float32Array, k: number, w: number, h: number): Mask {
  const small = new ImageData(M, M);
  for (let i = 0; i < M * M; i++) small.data[i * 4 + 3] = Math.max(0, Math.min(255, 128 + logits[k * M * M + i] * 32)); // 128 <-> logit 0
  const a = new OffscreenCanvas(M, M);
  a.getContext('2d')!.putImageData(small, 0, 0);
  const b = new OffscreenCanvas(w, h);
  const bctx = b.getContext('2d', { willReadFrequently: true })!;
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(a, 0, 0, w, h);
  const px = bctx.getImageData(0, 0, w, h).data;
  const data = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = px[i * 4 + 3] > 127 ? 1 : 0;
  return { data, width: w, height: h };
}
