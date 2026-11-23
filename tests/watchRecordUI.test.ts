// Record a skill in the windows: a recording that ended goes to the composer of the chat that started it (src/store/watchRecord.ts), and the composer's dialog
// starts one for its chat (src/components/composer/RecordSkill.tsx). Main is a fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const React = await import('react');
const { act, createElement } = React;
const { createRoot } = await import('react-dom/client');

const calls: any[] = [];
const f: any = { start: async () => ({ ok: true }) };
installNativeStub({ computer: { recordStart: (id: string) => (calls.push(['start', id]), f.start(id)) } });
const drafts: Record<string, any> = {};
stubStore({
  get: () => ({ drafts }),
  toast: (...a: any[]) => calls.push(['toast', ...a]),
  giveBackToComposer: (...a: any[]) => calls.push(['draft', ...a]),
});
const { onWatchRecordDone } = await import('../src/store/watchRecord.ts');
const { recordingAttachment, RECORDING_PROMPT, HOME_KEY } = await import('../src/store/computerHistory.ts');
const { RecordSkill } = await import('../src/components/composer/RecordSkill.tsx');

const BLOCK = '<sage-computer-history>\nx\n</sage-computer-history>';

test('a recording goes to its chat as a Computer History attachment with a first line asking for a skill', () => {
  calls.length = 0;
  onWatchRecordDone({ chatId: 'c1', steps: 3, block: BLOCK });
  assert.deepEqual(calls, [
    [
      'draft',
      'c1',
      RECORDING_PROMPT,
      [{ kind: 'computerHistory', path: 'computer-history:recording', name: 'Recording · 3 steps', text: BLOCK }],
    ],
    ['toast', 'Recording attached'],
  ]);
  // the new chat's box, one step, and a recording cut at its limit
  calls.length = 0;
  onWatchRecordDone({ chatId: HOME_KEY, steps: 1, block: BLOCK, limit: 'time' });
  assert.equal(calls[0][1], null);
  assert.equal((calls[0] as any[])[3][0].name, 'Recording · 1 step');
  assert.deepEqual(calls[1], ['toast', 'Recording attached · it reached its time limit']);
  assert.equal(recordingAttachment(0, BLOCK).name, 'Recording · 0 steps');
});

test('a second recording before the first was sent adds its block but not a second request', () => {
  calls.length = 0;
  drafts.c1 = { text: `${RECORDING_PROMPT} please`, attachments: [] };
  onWatchRecordDone({ chatId: 'c1', steps: 2, block: BLOCK, limit: 'size' });
  assert.equal((calls[0] as any[])[2], '');
  assert.deepEqual(calls[1], ['toast', 'Recording attached · it reached its size limit']);
  delete drafts.c1;
});

test('a recording that failed or caught nothing says so and attaches nothing', () => {
  calls.length = 0;
  onWatchRecordDone({ chatId: 'c1', error: 'The recording stopped because the computer-use helper quit' });
  onWatchRecordDone({ chatId: 'c1', steps: 0, block: null });
  assert.deepEqual(calls, [
    ['toast', 'The recording stopped because the computer-use helper quit', 'error'],
    ['toast', 'Nothing was recorded'],
  ]);
  calls.length = 0;
  onWatchRecordDone({ chatId: 'c1', block: BLOCK });
  assert.equal((calls[0] as any[])[3][0].name, 'Recording · 0 steps');
});

const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
async function mount(threadId: string | null) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  const out = { closed: 0 };
  await act(async () => root.render(createElement(RecordSkill, { threadId, onClose: () => out.closed++ })));
  const button = (text: string) => [...document.querySelectorAll('button')].find((b: any) => b.textContent.trim() === text) as any;
  const click = async (el: any) => {
    assert.ok(el);
    await act(async () => el.click());
    await flush();
  };
  return {
    out,
    button,
    click,
    text: () => document.body.textContent ?? '',
    close: async () => (await act(() => root.unmount()), host.remove()),
  };
}

test('the dialog says what is recorded and warns, then Start records for the chat and closes', async () => {
  calls.length = 0;
  f.start = async () => ({ ok: true });
  const m = await mount('c1');
  try {
    assert.match(m.text(), /Your clicks and typing are recorded, then sent to this chat to turn into a repeatable skill\./);
    assert.match(m.text(), /Don't type passwords or secrets/);
    await m.click(m.button('Start recording'));
    assert.deepEqual(calls, [['start', 'c1']]);
    assert.equal(m.out.closed, 1);
  } finally {
    await m.close();
  }
  // the new chat's box is recorded for as 'home'
  calls.length = 0;
  const home = await mount(null);
  try {
    await home.click(home.button('Start recording'));
    assert.deepEqual(calls, [['start', HOME_KEY]]);
  } finally {
    await home.close();
  }
});

test('Start that main refuses or that fails shows why and can be tried again; Cancel closes', async () => {
  f.start = async () => ({ ok: false, error: 'Allow Accessibility for MoPilot in Settings → Computer use, then try again' });
  const m = await mount('c1');
  try {
    await m.click(m.button('Start recording'));
    assert.match(m.text(), /Allow Accessibility for MoPilot/);
    assert.equal(m.out.closed, 0);
    assert.equal(m.button('Start recording').disabled, false);
    f.start = async () => {
      throw new Error("Error invoking remote method 'watchRecord:start': Error: gone");
    };
    await m.click(m.button('Start recording'));
    assert.match(m.text(), /gone/);
    assert.doesNotMatch(m.text(), /Allow Accessibility/);
    await m.click(m.button('Cancel'));
    assert.equal(m.out.closed, 1);
  } finally {
    await m.close();
  }
});
