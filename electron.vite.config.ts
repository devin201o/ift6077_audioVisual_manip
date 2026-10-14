import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';

// PACKAGING NOTE (electron-builder, later): onnxruntime-node ships native .node/.dylib binaries that
// cannot be loaded from inside an asar archive. Add to the builder config:
//   "asarUnpack": ["**/node_modules/onnxruntime-node/**"]
// and ship ./models via "extraResources" (src/main/sam.ts reads them from process.resourcesPath when packaged).
export default defineConfig({
  main: { build: { rollupOptions: { input: resolve('src/main/index.ts') } } }, // onnxruntime-node stays external (native addon)
  preload: { build: { rollupOptions: { input: resolve('src/preload/index.ts') } } },
  renderer: { root: 'src/renderer', build: { rollupOptions: { input: resolve('src/renderer/index.html') } } },
});
