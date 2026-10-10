// Run: node test/classifier.test.js
const assert = require('node:assert');
const T = require('../public/classifier.js');
const SAMPLES = require('../public/samples.js');

const expect = [
  // [index, dept, minLevel, lang]
  [0, 'safety', 'critical', 'en'],
  [1, 'lifts', 'high', 'gu-Latn'],
  [2, 'cleanliness', 'medium', 'gu'],
  [3, 'fare', 'medium', 'hi'],
  [4, 'staff', 'low', 'en'],
  [5, 'safety', 'critical', 'hi-Latn'],
  [6, 'safety', 'critical', 'gu'],
  [9, 'lifts', 'critical', 'hi'],
  [14, 'lifts', 'medium', 'hi-Latn'],
  [19, 'staff', 'low', 'gu-Latn'],
  [20, 'safety', 'critical', 'en'],
  [23, 'safety', 'critical', 'hi-Latn'],
];
const rank = { low: 0, medium: 1, high: 2, critical: 3 };

let fail = 0;
SAMPLES.forEach(([channel, text], i) => {
  const r = T.classify(text, { channel });
  console.log(`${String(i).padStart(2)} ${r.lang.padEnd(7)} ${r.dept.padEnd(11)} ${String(r.urgency).padStart(3)} ${r.level.padEnd(8)} ${(r.station || '-').padEnd(24)} ${text.slice(0, 50)}`);
});
for (const [i, dept, minLevel, lang] of expect) {
  const [channel, text] = SAMPLES[i];
  const r = T.classify(text, { channel });
  try {
    assert.strictEqual(r.dept, dept, `#${i} dept`);
    assert.ok(rank[r.level] >= rank[minLevel], `#${i} level ${r.level} < ${minLevel}`);
    assert.strictEqual(r.lang, lang, `#${i} lang`);
  } catch (e) { fail++; console.error('FAIL', e.message); }
}
const reply = T.draftReply({ id: 'CMP-1', dept: 'fare', level: 'medium', station: 'Paldi', lang: 'gu' });
assert.ok(reply.includes('CMP-1') && reply.includes('રિફંડ'));
console.log(fail ? `\n${fail} expectation(s) failed` : '\nAll expectations passed');
process.exit(fail ? 1 : 0);
