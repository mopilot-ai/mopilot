// ab-compare's observability rows (bench/lib/abObservability.mjs): each capability judged on what the fixture plants, the rows and their markdown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES, PLANTED_SECRET, judge, observabilityRows, observabilityMarkdown } from '../bench/lib/abObservability.mjs';

test('judge passes each capability only on what the fixture plants', () => {
  assert.deepEqual(judge('vitals', { text: 'LCP: 1 ms\nCLS: 0' }), { pass: true, note: 'LCP and CLS reported' });
  assert.deepEqual(judge('vitals', { text: 'nothing' }), { pass: false, note: 'no LCP or CLS' });
  assert.deepEqual(judge('a11y', { text: '[critical] image-alt\n[serious] label' }), {
    pass: true,
    note: 'found image-alt, label of image-alt, label',
  });
  assert.deepEqual(judge('a11y', { text: 'image-alt' }), { pass: false, note: 'found image-alt of image-alt, label' });
  assert.deepEqual(judge('a11y', {}), { pass: false, note: 'found none of image-alt, label' });
  assert.deepEqual(judge('har', { text: '{"url":"http://x/api.json"}' }), { pass: true, note: 'request kept, cookie redacted' });
  assert.deepEqual(judge('har', { text: `api.json ${PLANTED_SECRET}` }), { pass: false, note: 'the cookie is in the file' });
  assert.deepEqual(judge('har', { text: '{}' }), { pass: false, note: 'the fixture request is missing' });
  assert.deepEqual(judge('trace', { text: '{"traceEvents":[]}' }), { pass: true, note: 'trace saved (1 KB)' });
  assert.deepEqual(judge('trace', { text: '' }), { pass: false, note: 'no trace events' });
  assert.deepEqual(judge('record', { bytes: 2048 }), { pass: true, note: 'video saved (2 KB)' });
  assert.deepEqual(judge('record', {}), { pass: false, note: 'no video file' });
  assert.deepEqual(judge('react', { text: 'App [1]\n  Nav [2]\n  Hero [3]\n  Footer [4]\n    Link [5]' }), {
    pass: true,
    note: '5 components listed',
  });
  assert.deepEqual(judge('react', { text: '# React component tree\n0 1 - Root\n1 2 1 App\n2 3 2 Nav\n2 4 2 Main\n3 5 4 Card' }), {
    pass: true,
    note: '5 components listed',
  });
  assert.deepEqual(judge('react', { text: '# none\n\n' }), { pass: false, note: '0 components listed' });
  assert.deepEqual(judge('vue', { text: 'x' }), { pass: false, note: 'unknown capability vue' });
  // a failed command: the last line of what it printed
  assert.deepEqual(judge('record', { error: 'Command failed: ab record start\n✗ ffmpeg not found\n' }), {
    pass: false,
    note: 'error: ✗ ffmpeg not found',
  });
});

test('the rows judge both tools per capability, and the markdown tells parity', () => {
  const rows = observabilityRows({
    vitals: { ours: { text: 'LCP CLS' }, ab: { text: 'LCP CLS' } },
    record: { ours: { bytes: 10 }, ab: { error: 'no ffmpeg' } },
  });
  assert.deepEqual(
    rows.map((r: any) => r.id),
    CAPABILITIES.map((c: any) => c.id),
  );
  assert.equal(rows[0].command, 'vitals --json');
  assert.equal(rows[1].ours.note, 'error: not run');
  const md = observabilityMarkdown(rows);
  assert.match(md, /\| Web Vitals \| PASS `browser_vitals` \(LCP and CLS reported\) \| PASS `vitals --json` \(LCP and CLS reported\) \|/);
  assert.match(md, /\| Video \| PASS `browser_record` \(video saved \(1 KB\)\) \| FAIL `record start\|stop` \(error: no ffmpeg\) \|/);
  assert.match(md, /Parity: ours 2\/6, agent-browser 1\/6\./);
});
