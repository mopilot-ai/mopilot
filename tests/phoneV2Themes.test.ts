// The v2 surfaces in light and dark: every colour they draw is a theme token of the scheme on screen, and their text grows with the system text size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
const themePath = '../mobile/src/theme';
const rowPath = '../mobile/src/components/ChatRow';
const capsulePath = '../mobile/src/components/NewChatCapsule';
const pillPath = '../mobile/src/components/ComposerBox';
const wavePath = '../mobile/src/components/Waveform';
const noticePath = '../mobile/src/components/Notice';
const { light, dark } = await import(themePath);
const { ChatRow } = await import(rowPath);
const { NewChatCapsule } = await import(capsulePath);
const { ModelPill } = await import(pillPath);
const { Waveform } = await import(wavePath);
const { Notice } = await import(noticePath);

const COLOURS = ['color', 'backgroundColor', 'borderColor'];
const NOW = 1_800_000_000_000;
const scenes = () => [
  createElement(ChatRow, {
    chat: { id: 'a', title: 'Waits', state: 'waiting', harness: 'claude', at: NOW, changes: { added: 3, removed: 1 } },
    now: NOW,
    open: () => {},
  }),
  createElement(ChatRow, { chat: { id: 'b', title: 'Busy', state: 'running', at: NOW }, now: NOW, open: () => {} }),
  createElement(ChatRow, { chat: { id: 'c', title: 'Quiet', state: 'running', at: NOW - 3_600_000 }, now: NOW, open: () => {} }),
  createElement(ChatRow, { chat: { id: 'd', title: 'Done', state: 'idle', unread: true }, now: NOW, open: () => {} }),
  createElement(NewChatCapsule, { open: () => {} }),
  createElement(ModelPill, { model: 'Opus 5.5', detail: 'High', onPress: () => {} }),
  createElement(Waveform, { meter: { ms: 4200, levels: [{ at: 1, level: 0.4 }] } }),
  createElement(Notice, { lead: 'Stop not confirmed.', text: 'Check the chat before trying again.' }),
];

for (const [name, palette, isDark] of [
  ['light', light, false],
  ['dark', dark, true],
] as const) {
  test(`in ${name} the new surfaces draw only ${name} theme colours, and only glyphs keep their size`, async () => {
    (globalThis as any).__phoneDark = isDark;
    try {
      const allowed = new Set(Object.values(palette));
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      await act(async () =>
        root.render(
          createElement(
            'div',
            null,
            scenes().map((node, i) => createElement('div', { key: i }, node)),
          ),
        ),
      );
      await flush();
      const drawn = new Set<string>();
      for (const el of host.querySelectorAll('[data-style]')) {
        const style = JSON.parse(el.getAttribute('data-style')!);
        for (const key of COLOURS) if (typeof style[key] === 'string') drawn.add(style[key]);
        // text scales with the system size; only a lone glyph (the + of a round button, a chevron, a row's state or computer mark) holds its size
        if (el.getAttribute('data-allow-font-scaling') === 'false') assert.match(el.textContent!, /^[+↑×⌄›✋◌○●▭▤]$/);
      }
      assert.ok(drawn.size > 4, 'the scenes draw colours');
      for (const colour of drawn) assert.ok(allowed.has(colour), `${colour} is a ${name} token`);
      await act(async () => root.unmount());
      host.remove();
    } finally {
      delete (globalThis as any).__phoneDark;
    }
  });
}

test('a notice without a lead starts with its text, not a space that VoiceOver and XCTest read as part of the label', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Notice, { text: 'Mac accepted start; transcript pending.' })));
  assert.equal(host.textContent, 'Mac accepted start; transcript pending.');
  await act(async () => root.render(createElement(Notice, { lead: 'Stop not confirmed.', text: 'Check the chat.' })));
  assert.equal(host.textContent, 'Stop not confirmed. Check the chat.');
  await act(async () => root.unmount());
  host.remove();
});
