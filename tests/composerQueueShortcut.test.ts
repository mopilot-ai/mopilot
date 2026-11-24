// The live conversation composer carries each keyboard delivery choice through preparation, failures and chat changes.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import './support/dom.ts';
import { $, click } from './support/composer-kit.ts';
import { all, fx, last, mountComposer, reset, settle, setSessionState, store } from './support/composer-setup.ts';
import { deferred } from './support/async-scenarios.ts';

beforeEach(() => reset());
const running = () => store.set({ runtime: { t1: { activeTurnId: 'turn' } } });

for (const family of ['codex', 'claude', 'acp']) {
  for (const followUp of ['queue', 'steer']) {
    test(`${family}, ${followUp} preference: Enter requests immediate delivery and Cmd/Ctrl+Enter explicitly queues`, async () => {
      running();
      store.set((s: any) => ({
        prefs: { ...s.prefs, followUp },
        harnessOf: { t1: family },
        basicOf: family === 'acp' ? { t1: 'opencode' } : {},
      }));
      const m = await mountComposer({ threadId: 't1' });
      try {
        assert.equal(m.editor().dataset.placeholder, family === 'acp' ? '⏎ to queue for later' : '⏎ to send, ⌘⏎ to queue for later');
        for (const [text, keys, steer] of [
          ['send now', {}, true],
          ['after this', { metaKey: true }, false],
          ['also later', { ctrlKey: true }, false],
        ] as const) {
          await m.type(text);
          assert.equal(await m.key('Enter', keys), true);
          await settle();
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

test('Cmd+Enter send preference offers Shift+Cmd/Ctrl+Enter to queue and protects newlines and IME input', async () => {
  running();
  store.set((s: any) => ({ prefs: { ...s.prefs, sendWith: 'cmdEnter' } }));
  const m = await mountComposer({ threadId: 't1' });
  try {
    assert.equal(m.editor().dataset.placeholder, '⌘⏎ to send, ⇧⌘⏎ to queue for later');
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
    assert.equal(last('send')?.[4].steer, true);
    for (const modifier of ['metaKey', 'ctrlKey']) {
      await m.type('later');
      await m.key('Enter', { [modifier]: true, shiftKey: true });
      await settle();
      assert.equal(last('send')?.[4].steer, false);
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
            { plan: false, human: true, steer: sendWith === 'cmdEnter' && !shiftKey },
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
    await m.key('Enter', { metaKey: true });
    await m.key('Enter', { ctrlKey: true });
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
      await m.key('Enter', { metaKey: true });
      await settle();
      assert.equal(m.text, 'keep this');
      assert.equal(last('send')?.[4].steer, false);
      fx.sendFails = null;
      fx.sendAnswer = () => true;
      await m.key('Enter');
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
    await m.key('Enter', { metaKey: true });
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
