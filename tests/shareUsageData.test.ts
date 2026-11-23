// The usage-data sharing choice (src/components/pages/shareUsageData.ts) and how saved prefs load it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const calls: unknown[][] = [];
let consentFails = false;
installNativeStub({
  telemetry: {
    setConsent: async (v: boolean) => {
      calls.push(['consent', v]);
      if (consentFails) throw new Error('main is gone');
    },
  },
});
stubStore({
  setPrefs: (p: unknown) => calls.push(['prefs', p]),
  toastFailure: (what: string) => (e: Error) => calls.push(['failed', what, e.message]),
});
const { chooseShareUsageData } = await import('../src/components/pages/shareUsageData.ts');
const { loadPrefs } = await import('../src/store/types.ts');

test('a choice is stored and sent to main', async () => {
  calls.length = 0;
  chooseShareUsageData(true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [
    ['prefs', { shareUsageData: true }],
    ['consent', true],
  ]);
});

test("a choice main didn't get says so, so uploads aren't left on the old choice silently", async () => {
  calls.length = 0;
  consentFails = true;
  try {
    chooseShareUsageData(false);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, [
      ['prefs', { shareUsageData: false }],
      ['consent', false],
      ['failed', "Couldn't apply your usage data choice", 'main is gone'],
    ]);
  } finally {
    consentFails = false;
  }
});

test('preference loading enables missing or unset choices but preserves an explicit opt-out', () => {
  for (const saved of [undefined, {}, { shareUsageData: null }, { shareUsageData: true }]) {
    assert.equal(loadPrefs(saved).shareUsageData, true);
  }
  assert.equal(loadPrefs({ shareUsageData: false }).shareUsageData, false);
});
