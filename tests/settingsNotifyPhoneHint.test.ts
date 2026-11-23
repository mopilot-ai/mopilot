// Settings → General → Notifications: the Task finished and Goal updates rows say whether the phone gets a push (#3986).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, resetCtl, defaultState, useStore, render, text, row } from './support/settings-harness.ts';

await setup();
const { createElement: h } = await import('react');
const { Settings } = await import('../src/components/pages/Settings.tsx');

const prefs = (p: any) => useStore.setState({ prefs: { ...useStore.getState().prefs, ...p } });
const section = (s: string) => render(h(Settings, { section: s }));
beforeEach(() => {
  resetCtl();
  useStore.setState(defaultState(), true);
});

test('the Task finished and Goal updates rows say whether the phone gets a push: off unless the switch was turned on', async () => {
  const phoneNotes = (host: HTMLElement) => [...row(host, 'Notifications').querySelectorAll('.notify-phone')].map((n) => text(n));
  for (const [kinds, want] of [
    [undefined, ['Phone off', 'Phone off']],
    [{}, ['Phone off', 'Phone off']],
    [{ turn: false, goal: false }, ['Phone off', 'Phone off']],
    [{ turn: true }, ['Phone on', 'Phone off']],
    [{ turn: true, goal: true }, ['Phone on', 'Phone on']],
  ] as const) {
    prefs({ notifyKinds: kinds as any });
    const { host, unmount } = await section('general');
    assert.deepEqual(phoneNotes(host), want, JSON.stringify(kinds));
    await unmount();
  }
});
