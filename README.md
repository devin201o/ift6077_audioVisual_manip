# Cutout Lab

Desktop app (Electron + SAM 2.1 Small). Open an image or video, click an object to select it, click again for a bigger mask, and drag the cutout out of the frame. Segmentation runs locally with ONNX Runtime and works fully offline. Chips (see below) are optional: describing them uses an online vision model through OpenRouter with your own API key.

## Run it (macOS and Windows)

You need [Node.js](https://nodejs.org) 22.6 or newer (`.nvmrc` pins 22) and about 200 MB of free disk space.

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
- **Drag (more than 4 px):** lift the cutout. Release over the dock to add it as a chip; anywhere else (or Esc) it flies back and the selection stays.
- **"+" in the dock:** *Whole frame* adds the current frame (video keeps playing; the exact timestamp is recorded). *Object* starts object mode: select as usual, then click "Add to dock" or press Enter. Esc with no selection leaves the mode.
- **Dock:** drop image or video files on the right-hand dock to add chips. The arrow collapses it.
- **Video:** Space play/pause, ←/→ ±10 s, `,` and `.` step one frame while paused, `M` mute.

## Chips and the dock

Media you add to the dock becomes a *chip*: a thumbnail plus a description of what it is and how it feels (caption, mood words, a few 1-5 estimates, colour palette; objects also describe the surrounding scene). Chips are the groundwork for later features; nothing is done with them yet.

- **Add:** drop image/video files on the dock, drag a selection onto it, or use **+** (whole frame, or object).
- **Analysis is online and optional.** Open ⚙ and paste an [OpenRouter](https://openrouter.ai) key. The first time, a notice explains that a downscaled copy (long edge ≤ 1024 px; videos: 3 frames) of what you add is sent to OpenRouter and the model provider behind it. Nothing is sent until you add something, and identical content is never sent twice (chips are keyed by content hash). Without a key, chips are still created and show "Add API key to analyze".
- **Model:** default `anthropic/claude-haiku-5.5` (roughly $0.0005 per chip). Change it in ⚙ to any OpenRouter vision model that supports structured outputs.
- **Key storage:** encrypted with the OS keychain via Electron `safeStorage`, kept in the main process only; it never reaches the page, logs or chip files.
- **Click a chip** to edit its caption, vibe, moods and tags. Your edits are stored separately from the generated values, so re-analysis never overwrites them (↺ restores the generated text). The scale values are model estimates, not measurements.
- **Files:** `<app data>/library/<hash>/` holds `chip.json`, thumbnail, cutout, mask and the images sent for analysis. Chips point to the original file by path; if it moves, the chip shows "File missing" and **Relink** reconnects it.
- Failed analyses show **Retry**. Changing the model or a newer app version offers "Re-analyze outdated chips" in ⚙.
- `npm run check` runs the validator tests (Node 22.6+).

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
- Code layout: `src/main` (window, IPC, `sam.ts` for ONNX, `chips.ts` library + queue, `analyzer.ts` OpenRouter, `settings.ts` key), `src/preload` (typed `window.sam`), `src/renderer/src` (UI, dock, masks, cutouts, video), `src/shared` (chip types).
- Packaging (not set up yet): `onnxruntime-node` must be unpacked from asar (`asarUnpack: ["**/node_modules/onnxruntime-node/**"]`) and `models/` shipped via `extraResources`.

## Windows manual check

CI (macOS + Windows) covers install, typecheck, tests and build, but not the GUI. After changes that touch native or platform code, check on Windows (PowerShell):

1. `npm install`, `npm run fetch-models`, `npm run dev`. Console shows `execution provider: cpu`.
2. Open an image: click selects an object and mask colours look right (if colour-shifted, see the R/B swap in `preprocess()` in `src/main/sam.ts`).
3. Open an H.264 MP4: plays, seeks, steps frames.
4. Drag a cutout to the dock; drop a file on the dock; chip shows a path and **Relink** works.
5. ⚙ Save an API key (uses Windows DPAPI via `safeStorage`).
6. `npm run check` passes.
