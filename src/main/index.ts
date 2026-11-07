import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import * as sam from './sam';
import { initChips } from './chips';
import { initSettings } from './settings';

const DEBUG = process.env.SAM_DEBUG === '1';

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 900, backgroundColor: '#111113',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  sam.init().then((s) => !s.ready && console.error('[sam]', s.error)); // start loading sessions immediately

  ipcMain.handle('sam:status', () => sam.init());
  ipcMain.handle('sam:encode', (_e, frameId: number, rgba: Uint8Array, w: number, h: number) => sam.encode(frameId, rgba, w, h));
  ipcMain.handle('sam:decode', (_e, frameId: number, x: number, y: number, w: number, h: number) => sam.decode(frameId, x, y, w, h));

  initSettings();
  initChips();
  ipcMain.handle('debug', () => DEBUG);

  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => app.quit());
