import type { Descriptors, Level } from '../shared/chip';

// Model output is DATA. We copy only the fields we know, check types and ranges, and cap lengths.
// Nothing in the output is ever executed, fetched or used as an instruction.
const bad = (m: string): never => { throw new Error(`Invalid model response: ${m}`); };
const obj = (v: unknown, n: string) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : bad(n));
const str = (v: unknown, n: string, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : bad(n));
const strs = (v: unknown, n: string, min: number, max: number, cap: number) => {
  if (!Array.isArray(v) || v.length < min) bad(n);
  return (v as unknown[]).slice(0, max).map((s) => str(s, n, cap));
};
const level = (v: unknown, n: string): Level => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 5 ? (v as Level) : bad(n));
const palette = (v: unknown, n: string) => {
  const p = strs(v, n, 1, 6, 7);
  return p.every((c) => /^#[0-9a-fA-F]{6}$/.test(c)) ? p.map((c) => c.toLowerCase()) : bad(n);
};

/** Parse and validate the model's message content. Throws "Invalid model response: ..." on anything unexpected. */
export function parseDescriptors(content: string, withContext: boolean): Descriptors {
  let raw: unknown;
  try { raw = JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return bad('not JSON'); }
  const o = obj(raw, 'root'), vibe = obj(o.vibe, 'vibe'), vis = obj(o.visual, 'visual');
  let context: Descriptors['context'] = null;
  if (withContext) {
    const c = obj(o.context, 'context');
    context = { caption: str(c.caption, 'context.caption', 200), summary: str(c.summary, 'context.summary', 200), moods: strs(c.moods, 'context.moods', 1, 5, 24), palette: palette(c.palette, 'context.palette') };
  }
  return {
    caption: str(o.caption, 'caption', 200),
    tags: strs(o.tags, 'tags', 0, 8, 24),
    vibe: {
      summary: str(vibe.summary, 'vibe.summary', 200), moods: strs(vibe.moods, 'vibe.moods', 1, 5, 24),
      valence: level(vibe.valence, 'valence'), arousal: level(vibe.arousal, 'arousal'),
      tension: vibe.tension === null || vibe.tension === undefined ? null : level(vibe.tension, 'tension'),
    },
    visual: { estimated: true, palette: palette(vis.palette, 'palette'), brightness: level(vis.brightness, 'brightness'), contrast: level(vis.contrast, 'contrast'), saturation: level(vis.saturation, 'saturation'), warmth: level(vis.warmth, 'warmth') },
    context,
  };
}
