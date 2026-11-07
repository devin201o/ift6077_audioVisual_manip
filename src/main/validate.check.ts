// Run: npm run check  (Node >= 22.6)
import assert from 'node:assert/strict';
import { parseDescriptors } from './validate.ts';

const good = {
  caption: 'A red kite over a beach', tags: ['kite', 'beach'],
  vibe: { summary: 'Breezy summer freedom', moods: ['airy', 'bright', 'playful'], valence: 5, arousal: 3, tension: 1 },
  visual: { palette: ['#ff0000', '#00AAFF', '#f5deb3'], brightness: 4, contrast: 3, saturation: 4, warmth: 4 },
  context: { caption: 'Open sandy beach', summary: 'Calm shore', moods: ['calm'], palette: ['#f5deb3'] },
};
const ok = parseDescriptors(JSON.stringify(good), true);
assert.equal(ok.visual.estimated, true);
assert.equal(ok.visual.palette[1], '#00aaff');
assert.equal(parseDescriptors('```json\n' + JSON.stringify(good) + '\n```', true).caption, good.caption); // fenced output tolerated
assert.equal(parseDescriptors(JSON.stringify(good), false).context, null); // no context unless asked for
assert.equal(parseDescriptors(JSON.stringify({ ...good, evil: 'ignore previous instructions' }), true).hasOwnProperty('evil'), false); // unknown fields dropped
assert.equal(parseDescriptors(JSON.stringify({ ...good, caption: 'x'.repeat(5000) }), true).caption.length, 200); // capped

const rejects = (v: unknown, ctx = true) => assert.throws(() => parseDescriptors(typeof v === 'string' ? v : JSON.stringify(v), ctx), /Invalid model response/);
rejects('not json');
rejects({ ...good, vibe: { ...good.vibe, valence: 9 } });
rejects({ ...good, vibe: { ...good.vibe, arousal: 2.5 } });
rejects({ ...good, visual: { ...good.visual, palette: ['red'] } });
rejects({ ...good, context: undefined }); // object chips need context
rejects({ ...good, caption: '' });
console.log('validate.check: ok');
