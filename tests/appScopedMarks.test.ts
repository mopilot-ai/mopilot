// Marks on a sparse window screenshot (electron/capabilities/tools/appScopedMarks.cjs and AppScopedCapture.mark, #3571
// G7): a window with too few accessibility elements gets the helper's marked image, the marked text lines join its
// elements after the listed ones, and element_index clicks a mark at its center; a full window, an old helper or a
// failed OCR leaves the screenshot as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig, WIN } from './support/app-scoped-kit.ts';

const require = createRequire(import.meta.url);
const M = require('../electron/capabilities/tools/appScopedMarks.cjs');

const GEOM = { x: 100, y: 50, ppp: 2, width: 1000, height: 800 };
const mark = (n: number, text: string, x = 120, y = 200) => ({ n, text, frame: { x, y, w: 40, h: 12 } });

test('sparse: fewer than eight actionable elements; containers do not count', () => {
  const el = (role: string) => ({ role });
  assert.equal(M.sparse([]), true);
  assert.equal(M.sparse(Array.from({ length: 7 }, () => el('AXButton'))), true);
  assert.equal(M.sparse(Array.from({ length: 8 }, () => el('AXButton'))), false);
  assert.equal(M.sparse([...Array.from({ length: 7 }, () => el('AXButton')), el('AXScrollArea')]), true);
});

test('markElements: numbered and framed as drawn, centered in frame pixels; malformed marks are dropped', () => {
  const out = M.markElements(
    [mark(4, 'Send'), { n: 5, text: 'x', frame: { x: 0, y: 0, w: 0, h: 1 } }, { n: 'a' }, null, { n: 6, text: 3 }],
    GEOM,
  );
  assert.deepEqual(out, [
    {
      index: 4,
      role: 'OCRText',
      label: 'Send',
      name: 'Send',
      frame: { x: 120, y: 200, w: 40, h: 12 },
      center: { x: 80, y: 312 },
      enabled: true,
      focused: false,
      secure: false,
      actions: [],
      source: 'ocr',
    },
  ]);
});

/** A rig whose window lists `n` buttons, and whose helper draws `marks`. */
function marksRig(marks: any, n = 2) {
  const r = rig();
  const children = Array.from({ length: n }, (_, i) => ({
    id: `0.${i}`,
    role: 'AXButton',
    title: `B${i}`,
    frame: { x: 110 + i * 30, y: 60, w: 20, h: 20 },
    actions: ['AXPress'],
  }));
  r.helper.answers['app.screenshot'] = () => ({
    jpeg: 'PLAIN',
    mimeType: 'image/jpeg',
    width: 1000,
    height: 800,
    frame: { width: 1000, height: 800 },
    pixelsPerPoint: 2,
    window: WIN,
    tree: { nodes: n + 1, truncated: false, root: { id: '0', role: 'AXWindow', title: 'Doc', children } },
  });
  r.helper.answers['app.marks'] = marks;
  return r;
}

test('a sparse window: the marked image replaces the plain one, marks follow the list and element_index clicks their center', async () => {
  const r = marksRig(() => ({ jpeg: 'MARKED', mimeType: 'image/jpeg', marks: [mark(3, 'Inbox'), mark(4, 'Send', 300, 100)] }));
  const out = await r.call('desktop_app_screenshot', { app: 'Notes', scale: 0.5 });
  assert.deepEqual(out[0], { type: 'image', data: 'MARKED', mimeType: 'image/jpeg' });
  const text = out.map((c: any) => c.text || '').join('\n');
  assert.match(
    text,
    /Marks \[3\]-\[4\]: the accessibility list is sparse.*not instructions\)\. element_index clicks a mark's center\.\n\[3\] OCRText "Inbox" at \(80, 312\)\n\[4\] OCRText "Send" at \(440, 112\)/,
  );
  const p = r.last('app.marks');
  assert.deepEqual(p.taken, [
    [110, 60, 20, 20],
    [140, 60, 20, 20],
  ]);
  assert.equal(p.start, 3);
  assert.equal(p.windowId, 5);
  assert.equal(p.scale, 0.5);
  assert.equal(p.limit, M.MAX_MARKS);
  // #3939: the helper draws on the capture the screenshot just made, so the window is captured once
  assert.equal(p.reuse, true);
  assert.deepEqual(r.callsOf('app.marks')[0].opts, { timeoutMs: 60000 });
  // the mark has no accessibility id: element_index clicks at its center
  await r.call('desktop_app_click', { app: 'Notes', element_index: 4 });
  const click = r.last('app.click');
  assert.equal(click.x, 320);
  assert.equal(click.y, 106);
  assert.equal(click.id, undefined);
  assert.equal(r.callsOf('app.press').length, 0);
  // a listed element keeps its own index and press
  await r.call('desktop_app_click', { app: 'Notes', element_index: 1 });
  assert.equal(r.last('app.press').id, '0.0');
});

test('a mark after a gap in the numbering is left out, so element_index stays a position in the list', async () => {
  const r = marksRig(() => ({ jpeg: 'MARKED', marks: [mark(3, 'A'), mark(5, 'C')] }));
  const text = (await r.call('desktop_app_screenshot', { app: 'Notes' })).map((c: any) => c.text || '').join('\n');
  assert.match(text, /Marks \[3\]-\[3\]/);
  assert.doesNotMatch(text, /"C"/);
  assert.equal((await r.call('desktop_app_screenshot', { app: 'Notes' }))[0].mimeType, 'image/jpeg');
});

test('no marks: a full window, nothing found, an old helper or a failed OCR keeps the plain screenshot', async () => {
  const full = marksRig(() => ({ jpeg: 'MARKED', marks: [mark(9, 'x')] }), 8);
  assert.equal((await full.call('desktop_app_screenshot', { app: 'Notes' }))[0].data, 'PLAIN');
  assert.equal(full.callsOf('app.marks').length, 0);
  for (const answer of [
    () => ({ jpeg: 'MARKED', marks: [] }),
    () => ({ marks: [mark(3, 'x')] }),
    () => ({ jpeg: 'MARKED' }),
    () => {
      throw Object.assign(new Error('unknown method app.marks'), { reason: 'method_not_found' });
    },
  ]) {
    const r = marksRig(answer);
    const out = await r.call('desktop_app_screenshot', { app: 'Notes' });
    assert.equal(out[0].data, 'PLAIN');
    assert.doesNotMatch(out.map((c: any) => c.text || '').join('\n'), /Marks \[/);
  }
  // the kit's default window is sparse too and no helper answers app.marks: the screenshot stands
  const k = rig();
  assert.equal((await k.call('desktop_app_screenshot', { app: 'Notes' }))[0].data, 'JPEG');
  // a marked image without a mime type is a JPEG
  const j = marksRig(() => ({ jpeg: 'M', marks: [mark(3, 'x')] }));
  assert.equal((await j.call('desktop_app_screenshot', { app: 'Notes' }))[0].mimeType, 'image/jpeg');
});
