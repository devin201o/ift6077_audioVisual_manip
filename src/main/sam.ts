import * as ort from 'onnxruntime-node';
import { app, nativeImage } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// SAM 2.1 Hiera-Small, ONNX export from onnx-community (see scripts/fetch-models.mjs).
const SIZE = 1024; // model input; SAM2 stretches the frame to a square (no aspect-ratio padding)
const MASK = 256; // decoder output resolution
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
const DEBUG = process.env.SAM_DEBUG === '1';
const log = (...a: unknown[]) => DEBUG && console.log('[sam]', ...a);

const modelDir = () => (app.isPackaged ? join(process.resourcesPath, 'models') : join(app.getAppPath(), 'models'));

export interface Status { ready: boolean; ep?: string; error?: string; missing?: boolean }
export interface DecodeResult { stale?: boolean; logits?: Float32Array; scores?: number[]; objectScore?: number; n?: number }

let enc: ort.InferenceSession, dec: ort.InferenceSession;
let status: Status = { ready: false };
let loading: Promise<Status> | null = null;

// Only the current frame's embedding is kept; a new encode replaces (and frees) the old one.
let cache: { frameId: number; emb: Record<string, ort.Tensor> } | null = null;
let latestEncode = -1;

/** Benchmarked on Apple Silicon: CPU ~0.65 s encode / ~15 ms decode; CoreML 4-30 s encode. CPU is the default. SAM_EP=coreml opts in. */
function pickProviders(): { eps: ort.InferenceSession.ExecutionProviderConfig[]; label: string } {
  const want = (process.env.SAM_EP ?? 'cpu').toLowerCase();
  return want === 'coreml' ? { eps: ['coreml', 'cpu'], label: 'coreml' } : { eps: ['cpu'], label: 'cpu' };
}

export function init(): Promise<Status> {
  return (loading ??= (async () => {
    const dir = modelDir();
    const files = ['vision_encoder.onnx', 'vision_encoder.onnx_data', 'prompt_encoder_mask_decoder.onnx', 'prompt_encoder_mask_decoder.onnx_data'];
    if (files.some((f) => !existsSync(join(dir, f)))) {
      return (status = { ready: false, missing: true, error: `SAM 2.1 model files not found in ${dir}. Run: npm run fetch-models` });
    }
    let { eps, label } = pickProviders();
    // Arena off: with the BFC arena, the second encode in Electron aborts (EXC_BREAKPOINT in BFCArena::Extend, a huge aligned alloc).
    const opts = { logSeverityLevel: 3 as const, enableCpuMemArena: false, enableMemPattern: false };
    try {
      enc = await ort.InferenceSession.create(join(dir, files[0]), { executionProviders: eps, ...opts });
      dec = await ort.InferenceSession.create(join(dir, files[2]), { executionProviders: eps, ...opts });
    } catch (e) {
      if (label === 'cpu') return (status = { ready: false, error: `Failed to load model: ${e}` });
      console.warn(`[sam] ${label} session failed (${e}); falling back to cpu`);
      label = 'cpu';
      enc = await ort.InferenceSession.create(join(dir, files[0]), { executionProviders: ['cpu'], ...opts });
      dec = await ort.InferenceSession.create(join(dir, files[2]), { executionProviders: ['cpu'], ...opts });
    }
    console.log(`[sam] SAM 2.1 Small loaded, execution provider: ${label}`);
    log('encoder', enc.inputNames, '->', enc.outputNames, '| decoder', dec.inputNames, '->', dec.outputNames);
    return (status = { ready: true, ep: label });
  })());
}

export const getStatus = () => status;

/** RGBA frame (native res) -> resize to 1024x1024 -> ImageNet-normalised NCHW float tensor. */
function preprocess(rgba: Uint8Array, w: number, h: number): ort.Tensor {
  // nativeImage wants BGRA on macOS: swap R/B into a copy
  const bgra = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  const buf = Buffer.allocUnsafe(bgra.length);
  for (let i = 0; i < bgra.length; i += 4) { buf[i] = bgra[i + 2]; buf[i + 1] = bgra[i + 1]; buf[i + 2] = bgra[i]; buf[i + 3] = 255; }
  const small = nativeImage.createFromBitmap(buf, { width: w, height: h }).resize({ width: SIZE, height: SIZE, quality: 'good' }).toBitmap();
  const plane = SIZE * SIZE, out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    out[i] = (small[i * 4 + 2] / 255 - MEAN[0]) / STD[0]; // R
    out[plane + i] = (small[i * 4 + 1] / 255 - MEAN[1]) / STD[1]; // G
    out[2 * plane + i] = (small[i * 4] / 255 - MEAN[2]) / STD[2]; // B
  }
  return new ort.Tensor('float32', out, [1, 3, SIZE, SIZE]);
}

export async function encode(frameId: number, rgba: Uint8Array, w: number, h: number): Promise<{ ok: boolean; ms?: number }> {
  const st = await init();
  if (!st.ready) return { ok: false };
  latestEncode = frameId;
  const t0 = performance.now();
  const input = preprocess(rgba, w, h);
  const t1 = performance.now();
  const out = await enc.run({ pixel_values: input });
  const ms = Math.round(performance.now() - t0);
  log(`encode frame=${frameId} ${w}x${h} total=${ms}ms (preprocess ${Math.round(t1 - t0)}ms) ep=${status.ep}`);
  if (frameId !== latestEncode) return { ok: false }; // a newer frame was requested meanwhile: drop this embedding
  cache = { frameId, emb: out };
  return { ok: true, ms };
}

/** Decoder only. Point is in the frame's native pixels; (w,h) are the native frame size. */
export async function decode(frameId: number, x: number, y: number, w: number, h: number): Promise<DecodeResult> {
  if (!cache || cache.frameId !== frameId) return { stale: true };
  const t0 = performance.now();
  const feeds = {
    input_points: new ort.Tensor('float32', new Float32Array([(x / w) * SIZE, (y / h) * SIZE]), [1, 1, 1, 2]),
    input_labels: new ort.Tensor('int64', new BigInt64Array([1n]), [1, 1, 1]),
    input_boxes: new ort.Tensor('float32', new Float32Array(0), [1, 0, 4]),
    'image_embeddings.0': cache.emb['image_embeddings.0'],
    'image_embeddings.1': cache.emb['image_embeddings.1'],
    'image_embeddings.2': cache.emb['image_embeddings.2'],
  };
  const r = await dec.run(feeds);
  if (!cache || cache.frameId !== frameId) return { stale: true }; // frame changed while decoding
  const logits = r.pred_masks.data as Float32Array; // [1,1,N,256,256]
  const n = logits.length / (MASK * MASK);
  const scores = Array.from(r.iou_scores.data as Float32Array);
  const objectScore = (r.object_score_logits.data as Float32Array)[0];
  log(`decode frame=${frameId} point=(${Math.round(x)},${Math.round(y)}) ${Math.round(performance.now() - t0)}ms masks=${n} scores=${scores.map((s) => s.toFixed(3))} objectScore=${objectScore.toFixed(2)}`);
  return { logits: Float32Array.from(logits), scores, objectScore, n };
}
