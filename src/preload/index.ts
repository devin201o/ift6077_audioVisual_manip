import { contextBridge, ipcRenderer } from 'electron';

export interface SamStatus { ready: boolean; ep?: string; error?: string; missing?: boolean }
export interface DecodeResult { stale?: boolean; logits?: Float32Array; scores?: number[]; objectScore?: number; n?: number }

// The only surface the renderer sees. No Node access.
const api = {
  status: (): Promise<SamStatus> => ipcRenderer.invoke('sam:status'),
  encode: (frameId: number, rgba: Uint8ClampedArray, w: number, h: number): Promise<{ ok: boolean; ms?: number }> =>
    ipcRenderer.invoke('sam:encode', frameId, rgba, w, h),
  decode: (frameId: number, x: number, y: number, w: number, h: number): Promise<DecodeResult> =>
    ipcRenderer.invoke('sam:decode', frameId, x, y, w, h),
  saveCutout: (png: ArrayBuffer): Promise<number> => ipcRenderer.invoke('cutout:save', new Uint8Array(png)),
  startDrag: (id: number) => ipcRenderer.send('cutout:startDrag', id),
  clearCutouts: () => ipcRenderer.send('cutout:clearAll'),
  debug: (): Promise<boolean> => ipcRenderer.invoke('debug'),
};
contextBridge.exposeInMainWorld('sam', api);
export type SamApi = typeof api;
