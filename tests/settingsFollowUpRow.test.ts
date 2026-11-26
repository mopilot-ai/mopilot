// Settings → General's Follow-up row names the same submit and alternate chords the composer acts on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, useStore, render, row, text } from './support/settings-harness.ts';

await setup();
const { createElement: h } = await import('react');
const { Settings } = await import('../src/components/pages/Settings.tsx');

test('the Follow-up row names the submit chord as the setting and the alternate chord as the other, for each send-with choice', async () => {
  // the harness labels a modified chord `[chord]` (its shortcutLabel stand-in), so each label shows it came from the shared helper
  for (const [sendWith, desc] of [
    ['enter', 'What the Send button and ⏎ do while the agent is working. [⌘⏎] does the other one.'],
    ['cmdEnter', 'What the Send button and [⌘⏎] do while the agent is working. [⇧⌘⏎] does the other one.'],
  ]) {
    useStore.setState({ prefs: { ...useStore.getState().prefs, sendWith } });
    const { host, unmount } = await render(h(Settings, { section: 'general' }));
    try {
      assert.equal(text(row(host, 'Follow-up behavior').querySelector('.settings-row-desc')), desc);
    } finally {
      await unmount();
    }
  }
});
