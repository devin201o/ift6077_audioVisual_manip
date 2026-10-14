// Downloads the SAM 2.1 Hiera-Small ONNX export (fp32) into models/. Safe to re-run: existing files are skipped.
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const BASE = 'https://huggingface.co/onnx-community/sam2.1-hiera-small-ONNX/resolve/main/onnx/';
const FILES = [
  'vision_encoder.onnx', 'vision_encoder.onnx_data',
  'prompt_encoder_mask_decoder.onnx', 'prompt_encoder_mask_decoder.onnx_data',
];
mkdirSync('models', { recursive: true });

for (const f of FILES) {
  const dest = `models/${f}`;
  if (existsSync(dest)) { console.log(`skip ${f} (${(statSync(dest).size / 1e6).toFixed(1)} MB)`); continue; }
  console.log(`download ${f}`);
  const res = await fetch(BASE + f, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
  const tmp = dest + '.part';
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  renameSync(tmp, dest); // only complete files get the final name
}
console.log('models ready in ./models');
