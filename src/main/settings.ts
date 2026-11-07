import { app, ipcMain, safeStorage } from 'electron';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SettingsView } from '../shared/chip';

export const DEFAULT_MODEL = 'anthropic/claude-haiku-5.5';

interface Stored { model: string; privacyAck: boolean }
const file = (n: string) => join(app.getPath('userData'), n);
let stored: Stored | null = null;
const onKey: (() => void)[] = [];
/** Called after a key is saved (chips waiting for a key can start analysis). */
export const onKeySaved = (cb: () => void) => void onKey.push(cb);

function get(): Stored {
  if (stored) return stored;
  try { stored = { model: DEFAULT_MODEL, privacyAck: false, ...JSON.parse(readFileSync(file('settings.json'), 'utf8')) }; }
  catch { stored = { model: DEFAULT_MODEL, privacyAck: false }; }
  return stored!;
}
const put = (s: Partial<Stored>) => { stored = { ...get(), ...s }; writeFileSync(file('settings.json'), JSON.stringify(stored)); };

/** Main process only. The key never crosses IPC and is never logged. */
export function getKey(): string | null {
  try { return safeStorage.decryptString(readFileSync(file('key.bin'))); } catch { return null; }
}
export const getModel = () => get().model;
/** Analysis may run only with a key and the user's acknowledgement of the privacy notice. */
export const canAnalyze = () => get().privacyAck && getKey() !== null;

const view = (): SettingsView => ({ model: get().model, hasKey: existsSync(file('key.bin')), privacyAck: get().privacyAck, canEncrypt: safeStorage.isEncryptionAvailable() });

export function initSettings() {
  ipcMain.handle('settings:get', view);
  ipcMain.handle('settings:setKey', (_e, key: string, ack: boolean) => {
    if (typeof key !== 'string' || !key.trim() || key.length > 300) throw new Error('Invalid key');
    if (!get().privacyAck && ack !== true) throw new Error('Privacy notice not acknowledged');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure key storage is not available on this system');
    writeFileSync(file('key.bin'), safeStorage.encryptString(key.trim()));
    put({ privacyAck: true });
    onKey.forEach((cb) => cb());
    return view();
  });
  ipcMain.handle('settings:clearKey', () => { rmSync(file('key.bin'), { force: true }); return view(); });
  ipcMain.handle('settings:setModel', (_e, id: string) => {
    if (typeof id !== 'string' || !/^[\w.~:/-]{1,100}$/.test(id.trim())) throw new Error('Invalid model id');
    put({ model: id.trim() });
    return view();
  });
}
