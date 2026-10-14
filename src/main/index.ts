import { app, BrowserWindow, ipcMain, nativeImage } from 'electron';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as sam from './sam';

const DEBUG = process.env.SAM_DEBUG === '1';
const tmpDir = join(tmpdir(), `cutout-lab-${process.pid}`);
const files = new Map<number, string>(); // cutout id -> temp PNG path (for native drag-out)
let nextId = 1;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 900, backgroundColor: '#111113',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  mkdirSync(tmpDir, { recursive: true });
  sam.init().then((s) => !s.ready && console.error('[sam]', s.error)); // start loading sessions immediately

  ipcMain.handle('sam:status', () => sam.init());
  ipcMain.handle('sam:encode', (_e, frameId: number, rgba: Uint8Array, w: number, h: number) => sam.encode(frameId, rgba, w, h));
  ipcMain.handle('sam:decode', (_e, frameId: number, x: number, y: number, w: number, h: number) => sam.decode(frameId, x, y, w, h));

  ipcMain.handle('cutout:save', (_e, png: Uint8Array) => {
    const id = nextId++, path = join(tmpDir, `cutout-${id}.png`);
    writeFileSync(path, png);
    files.set(id, path);
    if (DEBUG) console.log(`[main] saved cutout ${path} (${png.byteLength} bytes)`);
    return id;
  });
  // Native OS drag (Finder, Notes, ...). Renderer calls this from a dragstart handler.
  ipcMain.on('cutout:startDrag', (e, id: number) => {
    const file = files.get(id);
    if (!file) return;
    const icon = nativeImage.createFromPath(file);
    const { width } = icon.getSize();
    if (DEBUG) console.log(`[main] startDrag ${file}`);
    e.sender.startDrag({ file, icon: icon.resize({ width: Math.min(96, width) }) });
  });
  ipcMain.on('cutout:clearAll', () => { for (const f of files.values()) rmSync(f, { force: true }); files.clear(); });
  ipcMain.handle('debug', () => DEBUG);

  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('will-quit', () => rmSync(tmpDir, { recursive: true, force: true }));
app.on('window-all-closed', () => app.quit());
