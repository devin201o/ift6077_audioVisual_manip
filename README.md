# Cutout Lab (Electron + SAM 2.1 Small)

Local desktop app: open an image or video, click an object to select it, click again to cycle through
bigger masks (part → sub-object → whole object), drag the cutout out of the frame. All inference runs
natively on this machine with ONNX Runtime. No network inference, no API keys.

## Setup

```sh
npm install          # also downloads the Electron binary (postinstall)
npm run fetch-models # one-off, ~185 MB into ./models (not committed)
npm run dev
```

If `models/` is missing, the app shows `SAM 2.1 model files missing. Run: npm run fetch-models`.

## Model

SAM 2.1 Hiera-Small, ONNX export from `onnx-community/sam2.1-hiera-small-ONNX` (fp32):
`vision_encoder.onnx(+_data)` (image encoder, once per frame) and `prompt_encoder_mask_decoder.onnx(+_data)`
(per click). The embedding stays cached in the main process; only the decoder runs per click.

## Execution providers

Default is **CPU** (fastest here: ~0.65–0.9 s encode, ~15 ms decode on Apple Silicon; CoreML measured 4–30 s per
encode because the graph splits into ~130 partitions). Switch with an env var:

```sh
SAM_EP=cpu    npm run dev   # default
SAM_EP=coreml npm run dev   # CoreML first, falls back to CPU if the session fails to create
SAM_DEBUG=1   npm run dev   # logs EP, encode/decode ms, mask count/areas/scores
```

## Controls

- Click: select the smallest mask. Click inside the selection: next larger mask (wraps). Click outside: new selection.
  Click background or press Esc: clear. Mouse movement alone does nothing.
- Press and drag (>4 px): lift the cutout (selects the object under the press first if nothing is selected there).
- Dropped cutouts: plain drag repositions; **Option-drag** starts a native OS drag (Finder, Notes, ...) with a temp PNG.
  A plain drag that leaves the window cannot turn into a native drag mid-gesture (platform limit).
- Video: Space play/pause, ←/→ ±10 s, `,` `.` frame step (assumes 30 fps) while paused, `M` mute/unmute (volume slider in the video bar).
- Timeline under a video: ruler, frame filmstrip, audio waveform and a playhead. View only; click or drag it to seek.

## Packaging notes (later)

`onnxruntime-node` ships native binaries that cannot load from inside an asar archive: use
`asarUnpack: ["**/node_modules/onnxruntime-node/**"]` and ship `models/` via `extraResources`
(`src/main/sam.ts` reads `process.resourcesPath/models` when packaged).

## Layout

`src/main` (window, IPC, `sam.ts` = ONNX sessions/preprocess/encode/decode), `src/preload` (typed `window.sam`),
`src/renderer/src` (UI, `segmentation.ts` logits→masks, `cutout.ts`, `video.ts`).
