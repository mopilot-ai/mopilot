// Settings → General renders independent quota-reset and harness-switch policies, including legacy preferences.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, useStore, render, row, flush } from './support/settings-harness.ts';

await setup();
const { createElement: h } = await import('react');
const { Settings } = await import('../src/components/pages/Settings.tsx');
const prefs = (p: any) => useStore.setState({ prefs: { ...useStore.getState().prefs, ...p } });
const section = (s: string) => render(h(Settings, { section: s }));

test('quota settings show independent defaults and saved choices', async () => {
  const { host, unmount } = await section('general');
  const checked = (title: string) => row(host, title).querySelector('[role=switch]')!.getAttribute('aria-checked');
  assert.equal(checked('Resume after quota resets'), 'true');
  assert.equal(checked('Switch harness at a usage limit'), 'false');
  for (const resume of [false, true]) {
    for (const switchHarness of [false, true]) {
      prefs({ autoContinueOnLimit: resume, autoSwitchHarnessOnLimit: switchHarness });
      await flush();
      assert.equal(checked('Resume after quota resets'), String(resume));
      assert.equal(checked('Switch harness at a usage limit'), String(switchHarness));
    }
  }
  await unmount();
});
