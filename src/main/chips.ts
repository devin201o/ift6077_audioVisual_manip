import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddInput, Chip, ChipView } from '../shared/chip';
import { AnalyzeError, openRouter, type AnalyzeInput, type Analyzer } from './analyzer';
import { canAnalyze, getKey, getModel, onKeySaved } from './settings';

const DEBUG = process.env.SAM_DEBUG === '1';
export const ANALYSIS_VERSION = 1; // bump when the prompt or schema changes; older chips can be re-analyzed
const MAX_PARALLEL = 2, TIMEOUT_MS = 60_000, MAX_NET_TRIES = 3;
const analyzer: Analyzer = openRouter;

// Must run before app ready. Lets the renderer load library files as chip://<id>/<file>.
protocol.registerSchemesAsPrivileged([{ scheme: 'chip', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const root = () => join(app.getPath('userData'), 'library');
const chips = new Map<string, Chip>();

const sha = (...parts: (string | number | Buffer | null)[]) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p === null ? '-' : typeof p === 'number' ? String(p) : p).update('|');
  return h.digest('hex');
};

// Hashing a multi-GB video is slow, so cache by path + size + mtime.
const hashCache = new Map<string, { size: number; mtimeMs: number; hash: string }>();
async function hashFile(path: string): Promise<string> {
  const st = statSync(path), hit = hashCache.get(path);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.hash;
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  const hash = h.digest('hex');
  hashCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, hash });
  return hash;
}

function load() {
  mkdirSync(root(), { recursive: true });
  for (const id of readdirSync(root())) {
    try { chips.set(id, JSON.parse(readFileSync(join(root(), id, 'chip.json'), 'utf8'))); }
    catch { console.warn(`[chips] skipping unreadable chip ${id}`); } // one bad file must not sink the library
  }
}
function save(c: Chip) {
  const f = join(root(), c.id, 'chip.json');
  writeFileSync(f + '.tmp', JSON.stringify(c, null, 2));
  renameSync(f + '.tmp', f);
}

const list = (): ChipView[] =>
  [...chips.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((c) => ({ ...c, missing: !!c.source.path && !existsSync(c.source.path) }));
const broadcast = () => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('chips:changed', list()); };

async function add(inp: AddInput): Promise<{ id: string; dup: boolean }> {
  if (!['object', 'image', 'clip'].includes(inp.kind) || !inp.thumb || !Array.isArray(inp.uploads)) throw new Error('bad chip input');
  const path = typeof inp.source.path === 'string' ? inp.source.path : null;
  const hash = path ? await hashFile(path).catch(() => null) : null;
  const t = inp.source.frameTime;
  // Same content -> same id -> no second chip and no second paid analysis.
  const id = inp.kind === 'object' ? sha('object', hash, t, Buffer.from(inp.cutout!))
    : t !== null ? sha('frame', hash, t)
    : hash ?? sha('bytes', Buffer.from(inp.uploads[0] ?? inp.thumb));
  if (chips.has(id)) return { id, dup: true };

  const dir = join(root(), id);
  mkdirSync(dir, { recursive: true });
  const files: Chip['files'] = { thumb: 'thumb.webp', uploads: inp.uploads.map((_, i) => `up-${i}.webp`) };
  writeFileSync(join(dir, files.thumb), Buffer.from(inp.thumb));
  inp.uploads.forEach((u, i) => writeFileSync(join(dir, files.uploads[i]), Buffer.from(u)));
  if (inp.cutout) { files.cutout = 'cutout.png'; writeFileSync(join(dir, files.cutout), Buffer.from(inp.cutout)); }
  if (inp.mask) { files.mask = 'mask.png'; writeFileSync(join(dir, files.mask), Buffer.from(inp.mask)); }

  const c: Chip = {
    schema: 1, id, kind: inp.kind, createdAt: new Date().toISOString(),
    source: { ...inp.source, path, hash },
    object: inp.object, files,
    analysis: { status: canAnalyze() ? 'pending' : 'needs-key', analyzer: analyzer.id, version: ANALYSIS_VERSION },
    auto: null, user: {}, motion: null, embedding: null,
  };
  chips.set(id, c); save(c); broadcast(); enqueue(id);
  if (DEBUG) console.log(`[chip] added ${id.slice(0, 8)} kind=${c.kind}`);
  return { id, dup: false };
}

// ---- analysis queue: only chips the user added are ever sent; identical content never is (same id = same chip) --------
const queue: string[] = [], running = new Set<string>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function enqueue(id: string) {
  if (running.has(id) || queue.includes(id)) return;
  queue.push(id); pump();
}
function pump() {
  while (running.size < MAX_PARALLEL && queue.length) {
    const id = queue.shift()!;
    running.add(id);
    run(id).catch((e) => console.warn('[chip] analysis crashed', (e as Error).message)).finally(() => { running.delete(id); pump(); });
  }
}
function setAnalysis(c: Chip, a: Partial<Chip['analysis']>) { c.analysis = { ...c.analysis, ...a }; save(c); broadcast(); }

async function run(id: string) {
  const c = chips.get(id);
  if (!c) return;
  const key = getKey();
  if (!canAnalyze() || !key) { if (c.analysis.status !== 'needs-key') setAnalysis(c, { status: 'needs-key', error: undefined }); return; }
  const model = getModel();
  setAnalysis(c, { status: 'pending', error: undefined, network: undefined, analyzer: analyzer.id, model });
  const roles = c.kind === 'object' ? ['object', 'scene'] as const : c.kind === 'clip' ? ['frame', 'frame', 'frame'] as const : ['frame'] as const;
  let input: AnalyzeInput;
  try {
    input = { kind: c.kind, images: c.files.uploads.map((f, i) => ({ role: roles[i] ?? 'frame', mime: 'image/webp', data: readFileSync(join(root(), id, f)) })) };
  } catch { setAnalysis(c, { status: 'failed', error: 'Upload images are missing' }); return; }

  const t0 = Date.now();
  let invalid = 0, tries = 0;
  for (;;) {
    try {
      const out = await analyzer.analyze(input, model, key, AbortSignal.timeout(TIMEOUT_MS));
      if (!chips.has(id)) return; // deleted meanwhile
      c.auto = out.d;
      setAnalysis(c, { status: 'done', error: undefined, network: undefined, model, version: ANALYSIS_VERSION, at: new Date().toISOString(), ms: Date.now() - t0, tokens: out.tokens, cost: out.cost });
      if (DEBUG) console.log(`[chip] analyzed ${id.slice(0, 8)} model=${model} ${Date.now() - t0}ms in=${out.tokens?.in} out=${out.tokens?.out}`);
      return;
    } catch (e) {
      const err = e instanceof AnalyzeError ? e : new AnalyzeError('Analysis failed');
      if (!chips.has(id)) return;
      if (err.invalid && invalid++ < 1) continue; // invalid output: retry once
      if (err.retryable && ++tries < MAX_NET_TRIES) { await sleep(err.retryAfterMs ?? 2000 * 2 ** (tries - 1)); continue; } // 2s, 4s
      if (DEBUG) console.log(`[chip] analysis failed ${id.slice(0, 8)}: ${err.message}`);
      setAnalysis(c, { status: 'failed', error: err.message, network: err.network });
      return;
    }
  }
}

/** Chips whose analysis predates the current prompt/schema or was made with another model. */
const outdated = () => canAnalyze() ? [...chips.values()].filter((c) => c.analysis.status !== 'needs-key' && c.analysis.status !== 'pending' && (c.analysis.version < ANALYSIS_VERSION || (!!c.analysis.model && c.analysis.model !== getModel()))) : [];

/** User edits live in `user`, apart from `auto`, so re-analysis never overwrites them. null / empty reverts a field. */
function edit(id: string, patch: Record<string, unknown>) {
  const c = chips.get(id);
  if (!c || !patch || typeof patch !== 'object') return;
  for (const k of ['caption', 'summary'] as const) if (k in patch) {
    const v = patch[k];
    if (typeof v === 'string' && v.trim()) c.user[k] = v.trim().slice(0, 200); else delete c.user[k];
  }
  for (const k of ['moods', 'tags'] as const) if (k in patch) {
    const v = Array.isArray(patch[k]) ? (patch[k] as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim()).slice(0, k === 'moods' ? 5 : 8).map((x) => x.trim().slice(0, 24)) : [];
    if (v.length) c.user[k] = v; else delete c.user[k];
  }
  save(c); broadcast();
}

async function relink(id: string, win: BrowserWindow | null) {
  const c = chips.get(id);
  if (!c || !win) return;
  const r = await dialog.showOpenDialog(win, { title: 'Locate the original file', properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return;
  const path = r.filePaths[0], hash = await hashFile(path);
  if (c.source.hash && hash !== c.source.hash) {
    const m = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Relink anyway', 'Cancel'], defaultId: 1, cancelId: 1, message: 'This file is different from the one the chip was made from.', detail: 'The chip keeps its stored thumbnail and description.' });
    if (m.response !== 0) return;
  }
  c.source.path = path; c.source.hash = hash;
  save(c); broadcast();
}

export function initChips() {
  load();
  onKeySaved(() => { for (const c of chips.values()) if (c.analysis.status === 'needs-key') enqueue(c.id); });
  for (const c of chips.values()) if (c.analysis.status === 'pending' || c.analysis.status === 'needs-key') enqueue(c.id); // interrupted or waiting
  protocol.handle('chip', (req) => {
    const u = new URL(req.url);
    if (!/^[0-9a-f]{64}$/.test(u.hostname) || !/^[\w.-]+$/.test(u.pathname.slice(1)) || u.pathname.includes('..')) return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(join(root(), u.hostname, u.pathname.slice(1))).toString());
  });
  ipcMain.handle('chips:list', list);
  ipcMain.handle('chips:add', (_e, inp: AddInput) => add(inp));
  ipcMain.handle('chips:edit', (_e, id: string, patch: Record<string, unknown>) => edit(id, patch));
  ipcMain.handle('chips:relink', (e, id: string) => relink(id, BrowserWindow.fromWebContents(e.sender)));
  ipcMain.handle('chips:outdated', () => outdated().length);
  ipcMain.handle('chips:reanalyze', (_e, ids?: string[]) => {
    const todo = Array.isArray(ids) ? ids.map((i) => chips.get(i)).filter((c): c is Chip => !!c) : outdated();
    todo.forEach((c) => enqueue(c.id));
    return todo.length;
  });
  ipcMain.handle('chips:retry', (_e, id: string) => { if (chips.has(id)) enqueue(id); });
  ipcMain.handle('chips:retryNetwork', () => { for (const c of chips.values()) if (c.analysis.status === 'failed' && c.analysis.network) enqueue(c.id); });
  ipcMain.handle('chips:remove', (_e, id: string) => {
    if (!chips.delete(id)) return;
    rmSync(join(root(), id), { recursive: true, force: true });
    broadcast();
  });
}
