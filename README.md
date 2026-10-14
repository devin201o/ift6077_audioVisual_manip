# Cutout Lab

Desktop app (Electron + SAM 2.1 Small). Open an image or video, click an object to select it, click again for a bigger mask, and drag the cutout out of the frame. Inference runs locally with ONNX Runtime: no network, no API keys.

## Run it (macOS and Windows)

You need [Node.js](https://nodejs.org) 20.19 or newer and about 200 MB of free disk space.

```sh
git clone https://github.com/devin201o/ift6077_audioVisual_manip.git
cd ift6077_audioVisual_manip
npm install
npm run fetch-models   # one-off download of the model files (~185 MB) into ./models
npm run dev
```

The same commands work in macOS Terminal, Windows PowerShell and cmd. If the app shows "SAM 2.1 model files missing", run `npm run fetch-models` again.

Apple Silicon and Windows x64/arm64 are supported. The CPU is used by default; the first encode of each frame takes roughly 1 s or more depending on the machine.

## Controls

- **Click:** select the smallest mask. Click inside the selection for the next larger mask. Click the background or press Esc to clear.
- **Drag (more than 4 px):** lift the cutout and move it around.
- **Option-drag (macOS) / Alt-drag (Windows):** drag the cutout out into Finder, Explorer or another app as a PNG.
- **Video:** Space play/pause, ←/→ ±10 s, `,` and `.` step one frame while paused, `M` mute.

## Options

Set these environment variables before `npm run dev`:

| Variable | Effect |
| --- | --- |
| `SAM_DEBUG=1` | Log timings and mask scores |
| `SAM_EP=coreml` | Try CoreML first (macOS only, usually slower), falls back to CPU |

macOS/Linux: `SAM_DEBUG=1 npm run dev`. PowerShell: `$env:SAM_DEBUG=1; npm run dev`. cmd: `set SAM_DEBUG=1 && npm run dev`.

## Notes

- Video: H.264 MP4 plays everywhere. HEVC `.mov` files may not play on Windows.
- Model: `onnx-community/sam2.1-hiera-small-ONNX` (fp32), downloaded by `scripts/fetch-models.mjs`.
- Code layout: `src/main` (window, IPC, `sam.ts` for ONNX), `src/preload` (typed `window.sam`), `src/renderer/src` (UI, masks, cutouts, video).
- Packaging (not set up yet): `onnxruntime-node` must be unpacked from asar (`asarUnpack: ["**/node_modules/onnxruntime-node/**"]`) and `models/` shipped via `extraResources`.
