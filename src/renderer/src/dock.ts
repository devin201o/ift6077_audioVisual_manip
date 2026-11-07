import { fileInput, type Prepared } from './cutout';
import type { ChipView } from '../../shared/chip';

/** Right-hand shelf of chips. Every chip, however created, goes through submit(). */
export function setupDock(openSettings: () => void) {
  document.getElementById('dgear')!.onclick = openSettings;
  const el = document.getElementById('dock')!, list = document.getElementById('chips')!, toggle = document.getElementById('dtoggle')!;
  const KEY = 'dock-collapsed';
  let fileExpanded = false; // expanded by a file drag hovering the rail: collapse again if it leaves without a drop
  let latest: ChipView[] = [];
  const holders = new Set<HTMLElement>(); // cards for chips still being prepared / hashed
  const collapsed = () => el.classList.contains('collapsed');
  const set = (c: boolean) => {
    closeMenu();
    el.classList.toggle('collapsed', c);
    toggle.textContent = c ? '‹' : '›';
    window.dispatchEvent(new Event('resize')); // stage and timeline re-measure
  };
  toggle.onclick = () => {
    set(!collapsed());
    try { localStorage.setItem(KEY, collapsed() ? '1' : '0'); } catch { /* storage unavailable */ }
  };

  function cardEl(label: string, thumbSrc: string | null) {
    const div = document.createElement('div'); div.className = 'chip';
    const row = document.createElement('div'); row.className = 'crow';
    const img = document.createElement('img'); img.draggable = false; if (thumbSrc) img.src = thumbSrc;
    const name = document.createElement('span'); name.textContent = label; // textContent only: labels can come from files/model output
    row.append(img, name);
    div.append(row);
    return { div, row, img, name };
  }
  const link = (label: string, fn: () => void) => { const k = document.createElement('button'); k.className = 'link'; k.textContent = label; k.onclick = (e) => { e.stopPropagation(); fn(); }; return k; };
  const open = new Set<string>(); // expanded cards

  /** Editable text fields (user value wins; ↺ reverts to the generated one) + read-only estimates and provenance. */
  function detail(c: ChipView) {
    const box = document.createElement('div'); box.className = 'detail';
    const d = c.auto;
    if (d) {
      const field = (label: string, key: 'caption' | 'summary' | 'moods' | 'tags', auto: string | string[]) => {
        const isList = Array.isArray(auto), user = c.user[key];
        const lab = document.createElement('label'); lab.textContent = label;
        const inp = document.createElement('input');
        inp.value = user === undefined ? (isList ? (auto as string[]).join(', ') : (auto as string)) : (Array.isArray(user) ? user.join(', ') : user);
        inp.onchange = () => window.lib.edit(c.id, { [key]: isList ? inp.value.split(',') : inp.value });
        lab.append(inp);
        if (user !== undefined) lab.append(link('↺ generated', () => window.lib.edit(c.id, { [key]: null })));
        box.append(lab);
      };
      field('Caption', 'caption', d.caption); field('Vibe', 'summary', d.vibe.summary); field('Moods', 'moods', d.vibe.moods); field('Tags', 'tags', d.tags);
      const ro = (t: string) => { const p = document.createElement('p'); p.className = 'ro'; p.textContent = t; box.append(p); };
      ro(`Estimates (model guesses, 1-5): valence ${d.vibe.valence} · arousal ${d.vibe.arousal}${d.vibe.tension ? ` · tension ${d.vibe.tension}` : ''} · brightness ${d.visual.brightness} · contrast ${d.visual.contrast} · saturation ${d.visual.saturation} · warmth ${d.visual.warmth}`);
      if (d.context) ro(`Scene: ${d.context.caption} (${d.context.moods.join(', ')})`);
    }
    const s = c.source, a = c.analysis;
    const t = s.frameTime !== null ? ` @ ${s.frameTime.toFixed(2)}s` : '';
    const p = document.createElement('p'); p.className = 'ro';
    p.textContent = `${c.kind} · ${s.name}${t} · ${s.w}×${s.h}${a.model ? ` · ${a.model}` : ''}${a.cost ? ` · $${a.cost.toFixed(5)}` : ''}`;
    box.append(p);
    const acts = document.createElement('p');
    if (c.missing) acts.append(link('Relink file', () => window.lib.relink(c.id)));
    if (a.status !== 'needs-key') acts.append(link('Re-analyze', () => window.lib.reanalyze([c.id])));
    box.append(acts);
    return box;
  }

  let stale = false; // a refresh arrived while a field was being edited
  function render() {
    if (list.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement) { stale = true; return; }
    stale = false;
    list.replaceChildren(...holders);
    for (const c of latest) {
      const { div, row, name } = cardEl(c.kind === 'object' ? 'Object' : c.source.name, `chip://${c.id}/${c.files.thumb}`);
      div.dataset.id = c.id;
      const note = document.createElement('small');
      const a = c.analysis, d = c.auto;
      if (d) {
        name.textContent = c.user.caption ?? d.caption;
        const moods = document.createElement('small'); moods.textContent = (c.user.moods ?? d.vibe.moods).join(' · ');
        const sw = document.createElement('div'); sw.className = 'sw';
        for (const col of d.visual.palette) { const i = document.createElement('i'); i.style.background = col; sw.append(i); }
        name.append(document.createElement('br'), moods, sw);
      }
      if (c.missing) { note.textContent = 'File missing '; note.append(link('Relink', () => window.lib.relink(c.id))); }
      else if (a.status === 'needs-key') note.append(link('Add API key to analyze', openSettings));
      else if (a.status === 'pending') note.textContent = 'Analyzing…';
      else if (a.status === 'failed') { note.textContent = `Failed: ${a.error ?? 'unknown error'} `; note.append(link('Retry', () => window.lib.retry(c.id))); }
      if (note.textContent || note.childElementCount) name.append(document.createElement('br'), note);
      const x = document.createElement('button'); x.textContent = '×'; x.title = 'Remove';
      x.onclick = (e) => { e.stopPropagation(); open.delete(c.id); window.lib.remove(c.id); };
      row.append(x);
      row.onclick = () => { open.has(c.id) ? open.delete(c.id) : open.add(c.id); render(); };
      if (open.has(c.id)) div.append(detail(c));
      list.append(div);
    }
  }
  list.addEventListener('focusout', () => setTimeout(() => stale && render(), 0));
  window.lib.list().then((l) => { latest = l; render(); });
  window.lib.onChanged((l) => { latest = l; render(); });

  const flash = (id: string) => {
    const d = list.querySelector<HTMLElement>(`[data-id="${id}"]`);
    d?.animate([{ background: '#3b82ff' }, { background: '#1c1c1e' }], 700);
  };

  // "+" menu: an array of entries, so more options are one line each
  const plus = document.getElementById('dplus') as HTMLButtonElement, menuEl = document.getElementById('dmenu')!;
  let items: { label: string; run: () => void }[] = [];
  const closeMenu = () => (menuEl.hidden = true);
  plus.onclick = () => {
    if (!menuEl.hidden) return closeMenu();
    menuEl.replaceChildren(...items.map((i) => {
      const b = document.createElement('button'); b.textContent = i.label;
      b.onclick = () => { closeMenu(); (document.activeElement as HTMLElement | null)?.blur(); i.run(); };
      return b;
    }));
    menuEl.hidden = false;
  };
  document.addEventListener('pointerdown', (e) => { if (!menuEl.hidden && !menuEl.contains(e.target as Node) && e.target !== plus) closeMenu(); }, true);
  // Esc closes the menu first, before the app's own Esc handling sees it
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menuEl.hidden) { closeMenu(); e.stopImmediatePropagation(); } }, true);

  const api = {
    collapsed,
    setMenu(i: typeof items) { items = i; },
    setPlusEnabled(on: boolean) { plus.disabled = !on; if (!on) closeMenu(); },
    expand: () => set(false),
    collapse: () => set(true),
    setHot: (on: boolean) => el.classList.toggle('hot', on),
    rect: () => el.getBoundingClientRect(),
    /** Pointer over the dock; a collapsed rail gets a wider hit zone so it is easy to reach. */
    hit(x: number, y: number) {
      const r = el.getBoundingClientRect(), pad = collapsed() ? 24 : 0;
      return x >= r.left - pad && x <= r.right && y >= r.top && y <= r.bottom;
    },
    /** A file drag left the window without a drop. */
    restore() { el.classList.remove('hot'); if (fileExpanded) set(true); fileExpanded = false; },
    /** The single chip pipeline: card at once, thumbnail as soon as it exists, then main hashes, dedupes and stores. */
    async submit(label: string, make: () => Promise<Prepared>) {
      const { div, img } = cardEl(label, null);
      holders.add(div); render();
      try {
        const { input, thumb } = await make();
        img.src = URL.createObjectURL(thumb);
        const r = await window.lib.add(input);
        holders.delete(div); render();
        URL.revokeObjectURL(img.src);
        if (r.dup) flash(r.id);
      } catch (e) {
        console.warn('[dock] could not add chip', e);
        holders.delete(div); render();
      }
    },
    addFile(file: File) {
      if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) return;
      api.submit(file.name, () => fileInput(file, window.lib.pathFor(file)));
    },
  };

  try { if (localStorage.getItem(KEY) === '1') set(true); } catch { /* storage unavailable */ }
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.classList.add('hot');
    if (collapsed()) { set(false); fileExpanded = true; }
  });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget as Node | null)) el.classList.remove('hot'); });
  el.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation(); // not an "open file" drop
    el.classList.remove('hot'); document.body.classList.remove('over'); fileExpanded = false;
    for (const f of Array.from(e.dataTransfer?.files ?? [])) api.addFile(f);
  });
  return api;
}
