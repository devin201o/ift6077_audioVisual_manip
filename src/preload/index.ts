import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AddInput, ChipView, SettingsView } from '../shared/chip';

export interface SamStatus { ready: boolean; ep?: string; error?: string; missing?: boolean }
export interface DecodeResult { stale?: boolean; logits?: Float32Array; scores?: number[]; objectScore?: number; n?: number }

// The only surface the renderer sees. No Node access.
const api = {
  status: (): Promise<SamStatus> => ipcRenderer.invoke('sam:status'),
  encode: (frameId: number, rgba: Uint8ClampedArray, w: number, h: number): Promise<{ ok: boolean; ms?: number }> =>
    ipcRenderer.invoke('sam:encode', frameId, rgba, w, h),
  decode: (frameId: number, x: number, y: number, w: number, h: number): Promise<DecodeResult> =>
    ipcRenderer.invoke('sam:decode', frameId, x, y, w, h),
  debug: (): Promise<boolean> => ipcRenderer.invoke('debug'),
};
contextBridge.exposeInMainWorld('sam', api);
export type SamApi = typeof api;

const lib = {
  list: (): Promise<ChipView[]> => ipcRenderer.invoke('chips:list'),
  add: (input: AddInput): Promise<{ id: string; dup: boolean }> => ipcRenderer.invoke('chips:add', input),
  edit: (id: string, patch: Partial<Record<'caption' | 'summary' | 'moods' | 'tags', string | string[] | null>>): Promise<void> => ipcRenderer.invoke('chips:edit', id, patch),
  relink: (id: string): Promise<void> => ipcRenderer.invoke('chips:relink', id),
  outdated: (): Promise<number> => ipcRenderer.invoke('chips:outdated'),
  reanalyze: (ids?: string[]): Promise<number> => ipcRenderer.invoke('chips:reanalyze', ids),
  retry: (id: string): Promise<void> => ipcRenderer.invoke('chips:retry', id),
  retryNetwork: (): Promise<void> => ipcRenderer.invoke('chips:retryNetwork'),
  remove: (id: string): Promise<void> => ipcRenderer.invoke('chips:remove', id),
  onChanged: (cb: (chips: ChipView[]) => void) => { ipcRenderer.on('chips:changed', (_e, l) => cb(l)); },
  settings: {
    get: (): Promise<SettingsView> => ipcRenderer.invoke('settings:get'),
    setKey: (key: string, ack: boolean): Promise<SettingsView> => ipcRenderer.invoke('settings:setKey', key, ack), // one-way: nothing returns the key
    clearKey: (): Promise<SettingsView> => ipcRenderer.invoke('settings:clearKey'),
    setModel: (id: string): Promise<SettingsView> => ipcRenderer.invoke('settings:setModel', id),
  },
  pathFor: (file: File): string => webUtils.getPathForFile(file), // '' when the file has no path on disk
};
contextBridge.exposeInMainWorld('lib', lib);
export type LibApi = typeof lib;
