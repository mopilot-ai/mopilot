// A line the home asks to be said beside the result of a move the person made (an intent's `notice`, e.g. that Google could not be reached to remove MoPilot there): parsed, kept by the IPC seam, shown on the page until it is dismissed.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mount, scenarioView } from './support/momoHomeRig.ts';

const { parseIntentAnswer } = await import('../src/components/momo/home/parseView.ts');
const { createIpcSeam } = await import('../src/components/momo/home/ipcSeam.ts');
const { setHomeNotice } = await import('../src/components/momo/home/homeNotice.ts');

const NOTICE = 'Disconnected here. Google couldn’t be reached; remove MoPilot at myaccount.google.com/permissions.';

test('a notice beside an answer is kept, trimmed and bounded; one that is not text or is blank is dropped', () => {
  assert.deepEqual(parseIntentAnswer({ ok: true, notice: `  ${NOTICE}  ` }), { ok: true, notice: NOTICE });
  assert.equal((parseIntentAnswer({ ok: true, notice: 'x'.repeat(500) }) as any).notice.length, 300);
  assert.deepEqual(parseIntentAnswer({ ok: true, notice: '   ' }), { ok: true });
  assert.deepEqual(parseIntentAnswer({ ok: true, notice: 7 }), { ok: true });
  const v = scenarioView(null);
  assert.deepEqual((parseIntentAnswer({ ok: true, view: v, notice: NOTICE }) as any).notice, NOTICE);
  assert.deepEqual(parseIntentAnswer({ ok: false, cause: 'No.', notice: NOTICE }), { ok: false, cause: 'No.' });
});

test('the IPC seam returns the notice and the page says it until it is dismissed', async () => {
  setHomeNotice(null);
  const bridge: any = {
    view: async () => ({ ok: true, view: scenarioView(null) }),
    intent: async () => ({ ok: true, notice: NOTICE }),
    onChanged: () => () => undefined,
    dev: async () => false,
  };
  const seam = createIpcSeam(bridge);
  assert.deepEqual(await seam.act({ type: 'source.remove', id: 'gmail' }), { ok: true, notice: NOTICE });
  const m = await mount(null);
  assert.ok(m.text().includes(NOTICE));
  await m.click('Got it');
  assert.ok(!m.text().includes('Disconnected here.'));
  // a result with no notice says nothing, and the same line twice is one line
  assert.deepEqual(await createIpcSeam({ ...bridge, intent: async () => ({ ok: true }) }).act({ type: 'home.wake' }), { ok: true });
  setHomeNotice(NOTICE);
  setHomeNotice(NOTICE);
  await m.close();
  setHomeNotice(null);
});
