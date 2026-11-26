// The live conversation composer carries each keyboard delivery choice through preparation, failures and chat changes.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import './support/dom.ts';
import { $, click, mouse } from './support/composer-kit.ts';
import { all, fx, last, mountComposer, reset, settle, setSessionState, store } from './support/composer-setup.ts';
import { deferred } from './support/async-scenarios.ts';

beforeEach(() => reset());
const running = () => store.set({ runtime: { t1: { activeTurnId: 'turn' } } });

/** The Send tooltip: its label and the submit chord. */
async function sendTooltip() {
  await mouse($('[aria-label="Send"]').parentElement!, 'mouseover');
  await settle(460);
  const label = $('.tooltip')?.textContent;
  await mouse($('[aria-label="Send"]').parentElement!, 'mouseout');
  return label;
}

// a machine's Claude Code or Codex chat is basic-tier here (`acp:host-claude:…`) and steers on its Host: main's `steer`
// capability says so (tests/steerCaps.test.ts), and the label and hint read it; the keys name no harness either way
for (const [family, harness, basic, cap] of [
  ['codex', 'codex', null, 'native'],
  ['claude', 'claude', null, 'native'],
  ['acp', 'acp', 'opencode', 'absent'],
  ['host-claude', 'acp', 'host-claude', 'native'],
  ['host-codex', 'acp', 'host-codex', 'native'],
  ['host-claude switched to a basic agent', 'acp', 'host-claude', 'absent'],
] as const) {
  for (const followUp of ['queue', 'steer']) {
    test(`${family}, ${followUp} preference: Enter asks for the Follow-up setting and Cmd/Ctrl+Enter for the other`, async () => {
      running();
      store.set((s: any) => ({
        prefs: { ...s.prefs, followUp },
        harnessOf: { t1: harness },
        basicOf: basic ? { t1: basic } : {},
      }));
      fx.chatCaps = { ...fx.chatCaps, steer: { state: cap, via: cap === 'native' ? 'rpc' : 'none' } };
      const m = await mountComposer({ threadId: 't1' });
      try {
        const steers = cap === 'native';
        assert.equal(
          m.editor().dataset.placeholder,
          !steers
            ? '⏎ to queue for later'
            : followUp === 'queue'
              ? '⏎ to queue for later, ⌘⏎ to send now'
              : '⏎ to send now, ⌘⏎ to queue for later',
        );
        await m.type('label');
        assert.equal(await sendTooltip(), steers && followUp === 'steer' ? 'Steer⏎' : 'Queue message⏎');
        await m.key('Enter');
        await settle();
        assert.equal(last('send')?.[4].steer, followUp === 'steer', 'Enter asks for what the label says, or for a steer main queues');
        for (const [text, keys, alternate] of [
          ['as set', {}, false],
          ['the other', { metaKey: true }, true],
          ['the other again', { ctrlKey: true }, true],
        ] as const) {
          await m.type(text);
          assert.equal(await m.key('Enter', keys), true);
          await settle();
          // main queues a steer the chat's agent can't take (tests/composerSendKeys.test.ts drives that for ACP)
          const steer = (followUp === 'steer') !== alternate;
          assert.deepEqual(last('send'), ['send', 't1', text, [], { plan: false, human: true, steer }]);
          assert.equal(m.text, '');
        }
        await m.type('button default');
        await click($('[aria-label="Send"]'));
        await settle();
        assert.deepEqual(last('send')?.[4], { plan: false, human: true }, 'clicking Send retains the saved preference');
      } finally {
        await m.unmount();
      }
    });
  }
}

test("until main answers, the chat's tier stands in for its steer capability; while main is asked again, its last answer stands", async () => {
  running();
  store.set((s: any) => ({
    prefs: { ...s.prefs, followUp: 'steer' },
    harnessOf: { t1: 'acp', t2: 'codex' },
    basicOf: { t1: 'host-claude' },
  }));
  const unloaded = () => ((fx.capsLoaded = false), (fx.chatCaps = { ...fx.chatCaps, steer: { state: 'absent', via: 'none' } }));
  const loaded = (state: string) => ((fx.capsLoaded = true), (fx.chatCaps = { ...fx.chatCaps, steer: { state, via: 'rpc' } }));
  // what an unloaded read holds is never read: a machine's chat waits for main's word
  unloaded();
  const m = await mountComposer({ threadId: 't1' });
  try {
    assert.equal(m.editor().dataset.placeholder, '⏎ to queue for later');
    await m.type('wait');
    assert.equal(await sendTooltip(), 'Queue message⏎');
    loaded('native');
    await m.rerender();
    assert.equal(await sendTooltip(), 'Steer⏎');
    await m.key('Enter');
    await settle();
    assert.equal(m.editor().dataset.placeholder, '⏎ to send now, ⌘⏎ to queue for later');
    // a caps input changed (a turn started, the agent's usage arrived): Steer stays while main is asked again
    unloaded();
    await m.rerender();
    assert.equal(m.editor().dataset.placeholder, '⏎ to send now, ⌘⏎ to queue for later');
    // main's next word decides (the Host switched the chat to a basic agent)
    loaded('absent');
    await m.rerender();
    assert.equal(m.editor().dataset.placeholder, '⏎ to queue for later');
    // another chat never reads this one's answer: a first-tier chat steers by its tier until main answers for it
    unloaded();
    store.set({ runtime: { t2: { activeTurnId: 'turn' } } });
    await m.rerender({ threadId: 't2' });
    assert.equal(m.editor().dataset.placeholder, '⏎ to send now, ⌘⏎ to queue for later');
  } finally {
    await m.unmount();
  }
});

test('Cmd+Enter send preference: Cmd/Ctrl+Enter queues as set, Shift added sends now, and newlines and IME input stay', async () => {
  running();
  store.set((s: any) => ({ prefs: { ...s.prefs, sendWith: 'cmdEnter' } }));
  const m = await mountComposer({ threadId: 't1' });
  try {
    assert.equal(m.editor().dataset.placeholder, '⌘⏎ to queue for later, ⇧⌘⏎ to send now');
    await m.type('still typing');
    for (const keys of [
      {},
      { shiftKey: true },
      { altKey: true, metaKey: true },
      { metaKey: true, isComposing: true },
      { ctrlKey: true, keyCode: 229 },
    ])
      assert.equal(await m.key('Enter', keys), false);
    assert.equal(all('send').length, 0);
    await m.key('Enter', { metaKey: true });
    await settle();
    assert.equal(last('send')?.[4].steer, false);
    for (const modifier of ['metaKey', 'ctrlKey']) {
      await m.type('now');
      await m.key('Enter', { [modifier]: true, shiftKey: true });
      await settle();
      assert.equal(last('send')?.[4].steer, true);
    }
  } finally {
    await m.unmount();
  }
});

test('modified submit chords reach delivery while a mention menu is open, and plain Enter still picks a suggestion', async () => {
  running();
  fx.files = [{ path: '/home/a.ts', file_name: 'a.ts', indices: null }];
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.type('see @a');
    await settle(130);
    assert.ok($('.composer-popup .mention-name'));
    await m.key('Enter');
    assert.equal(m.text, 'see @/home/a.ts ');
    assert.equal(all('send').length, 0);
    for (const sendWith of ['enter', 'cmdEnter']) {
      await act(async () => store.set((s: any) => ({ prefs: { ...s.prefs, sendWith } })));
      for (const modifier of ['metaKey', 'ctrlKey']) {
        for (const shiftKey of sendWith === 'enter' ? [false] : [false, true]) {
          await m.type('see @a');
          await settle(130);
          assert.ok($('.composer-popup .mention-name'));
          await m.key('Enter', { [modifier]: true, shiftKey });
          await settle();
          assert.equal(m.text, '');
          assert.deepEqual(last('send')?.slice(2), [
            'see @a',
            [],
            // the Queue setting: Cmd+Enter is the alternate chord of Enter, the submit chord of Cmd+Enter
            { plan: false, human: true, steer: sendWith === 'enter' || shiftKey },
          ]);
        }
      }
    }
  } finally {
    await m.unmount();
  }
});

test('an open mention menu leaves Shift/Alt+Enter and IME Enter/Escape to the editor', async () => {
  running();
  fx.files = [{ path: '/home/a.ts', file_name: 'a.ts', indices: null }];
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.type('see @a');
    await settle(130);
    assert.ok($('.composer-popup .mention-name'));
    for (const keys of [{ shiftKey: true }, { altKey: true }, { metaKey: true, altKey: true }, { isComposing: true }, { keyCode: 229 }]) {
      assert.equal(await m.key('Enter', keys), false);
      assert.equal(m.text, 'see @a');
      assert.equal(all('send').length, 0);
    }
    for (const keys of [{ isComposing: true }, { keyCode: 229 }]) {
      assert.equal(await m.key('Escape', keys), false);
      assert.ok($('.composer-popup .mention-name'));
      assert.equal(m.text, 'see @a');
    }
    await m.key('Escape');
    assert.equal($('.composer-popup'), null);
  } finally {
    await m.unmount();
  }
});

test('queue intent keeps its attachments and plan when the turn finishes and preferences change during preparation', async () => {
  running();
  const refs = deferred<any[]>();
  fx.refs = () => refs.promise;
  const attachment = { kind: 'file', path: '/notes.txt', name: 'notes.txt' };
  store.set({ drafts: { t1: { text: 'later', attachments: [attachment] } } });
  setSessionState('t1', { plan: true });
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.key('Enter');
    await m.key('Enter');
    assert.equal(all('send').length, 0);
    await act(async () => store.set((s: any) => ({ runtime: {}, prefs: { ...s.prefs, followUp: 'steer' } })));
    await act(async () => refs.resolve([]));
    await settle();
    assert.deepEqual(all('send'), [['send', 't1', 'later', [attachment], { plan: true, human: true, steer: false }]]);
    assert.equal(m.text, '');
  } finally {
    refs.resolve([]);
    await m.unmount();
  }
});

for (const fails of [false, true]) {
  test(`a ${fails ? 'rejected' : 'refused'} queued send retains the draft and can be retried with its selected intent`, async () => {
    running();
    fx.sendAnswer = () => false;
    if (fails) fx.sendFails = new Error('offline');
    const m = await mountComposer({ threadId: 't1' });
    try {
      await m.type('keep this');
      await m.key('Enter');
      await settle();
      assert.equal(m.text, 'keep this');
      assert.equal(last('send')?.[4].steer, false);
      fx.sendFails = null;
      fx.sendAnswer = () => true;
      await m.key('Enter', { metaKey: true });
      await settle();
      assert.equal(last('send')?.[4].steer, true);
      assert.equal(m.text, '');
    } finally {
      await m.unmount();
    }
  });
}

test('switching chats retires a pending queue preparation; the new chat still sends normally', async () => {
  running();
  const refs = deferred<any[]>();
  fx.refs = () => refs.promise;
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.type('old chat');
    await m.key('Enter');
    await m.rerender({ threadId: 't2' });
    await act(async () => refs.resolve([]));
    await settle();
    assert.equal(all('send').length, 0);
    assert.equal(store.get().drafts.t1.text, 'old chat');
    fx.refs = async () => [];
    await m.type('current chat');
    await m.key('Enter');
    await settle();
    assert.deepEqual(last('send')?.slice(1, 3), ['t2', 'current chat']);
  } finally {
    refs.resolve([]);
    await m.unmount();
  }
});
