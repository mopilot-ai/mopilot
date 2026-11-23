// The composer's Remote Control entry in the "/" menu (useSlashItems in src/components/composer/ComposerSlash.tsx): it links the chat,
// shows the link's state, and is greyed with the reason where the chat's harness or login can't have it.
import { test, beforeEach } from 'node:test';
import { act } from 'react';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, mouse } from './support/composer-kit.ts';
import { all, fx, last, mountComposer, reset, settle, setSessionState, store } from './support/composer-setup.ts';

beforeEach(() => reset());
const row = (title: string) => $$('.slash-panel .add-panel-item').find((x) => x.querySelector('.add-panel-title')!.textContent === title)!;
const desc = (title: string) => row(title).querySelector('.add-panel-desc')?.textContent;
async function pick(m: any, query: string, ...path: string[]) {
  await m.type('/' + query);
  for (const t of path) {
    await mouse(row(t), 'mousedown');
    await settle();
  }
}

test('Remote Control: links the chat, shows its state, and says why it is unavailable', async () => {
  // a Claude Code chat: its link is the session's
  store.set({ harnessOf: { t1: 'claude' } });
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.type('/remote');
    assert.equal(desc('Remote Control'), 'Follow this chat from claude.ai or the Claude app');
    assert.equal(row('Remote Control').querySelector('.add-panel-check'), null);
    await pick(m, 'remote-control', 'Remote Control');
    assert.deepEqual(last('remoteControl'), ['remoteControl', 't1', true]);
    for (const [state, text] of [
      ['connecting', 'Connecting…'],
      ['on', 'Linked to claude.ai'],
    ] as const) {
      await act(async () =>
        setSessionState('t1', { remoteControl: { state, url: 'https://claude.ai/code/session_a', error: null, wanted: true } }),
      );
      await m.rerender();
      await m.type('/remote');
      assert.equal(desc('Remote Control'), text);
      assert.ok(row('Remote Control').querySelector('.add-panel-check'));
      await pick(m, 'remote', 'Remote Control');
      assert.deepEqual(last('remoteControl'), ['remoteControl', 't1', false]);
    }
    // waiting for the network or a sign-in: still linked as far as the switch goes, and says what it waits for
    for (const [state, error] of [
      ['offline', 'Offline: reconnecting when the network is back'],
      ['signin', 'Sign in to Claude Code to reconnect Remote Control'],
    ] as const) {
      await act(async () => setSessionState('t1', { remoteControl: { state, url: null, error, wanted: true } }));
      await m.rerender();
      await m.type('/remote');
      assert.equal(desc('Remote Control'), error);
      assert.ok(row('Remote Control').querySelector('.add-panel-check'));
      await pick(m, 'remote', 'Remote Control');
      assert.deepEqual(last('remoteControl'), ['remoteControl', 't1', false]);
    }
    // a failed connect shows its error, and picking it again tries again
    await act(async () =>
      setSessionState('t1', {
        remoteControl: { state: 'error', url: null, error: 'Remote Control did not connect in time', wanted: true },
      }),
    );
    await m.rerender();
    await m.type('/remote');
    assert.equal(desc('Remote Control'), 'Remote Control did not connect in time');
    await pick(m, 'remote', 'Remote Control');
    assert.deepEqual(last('remoteControl'), ['remoteControl', 't1', true]);
    // a chat whose harness can't have it is greyed out with the reason and does nothing
    await act(async () => setSessionState('t1', { remoteControl: null }));
    fx.chatCaps = {
      ...fx.chatCaps,
      remoteControl: { state: 'absent', via: 'none', why: { layer: 'harness', code: 'harness.noRemoteControl' } },
    };
    const before = all('remoteControl').length;
    await m.rerender();
    await m.type('/remote');
    assert.match(desc('Remote Control')!, /Not available for this chat/);
    await pick(m, 'remote', 'Remote Control');
    assert.equal(all('remoteControl').length, before);
    // a login that can't have it says so the same way
    fx.chatCaps = {
      ...fx.chatCaps,
      remoteControl: { state: 'disabled', via: 'rpc', why: { layer: 'account', code: 'account.remoteControlNeedsClaudeAi' } },
    };
    await m.rerender();
    await m.type('/remote');
    assert.match(desc('Remote Control')!, /needs a claude\.ai Pro, Max, Team or Enterprise login/);
    // no reason (nothing to say) keeps the entry usable
    fx.chatCaps = { ...fx.chatCaps, remoteControl: { state: 'native', via: 'rpc' } };
    await m.rerender();
    await m.type('/remote');
    assert.equal(desc('Remote Control'), 'Follow this chat from claude.ai or the Claude app');
  } finally {
    await m.unmount();
  }
  // a new chat has no session to link
  const m2 = await mountComposer({ threadId: null });
  try {
    await m2.type('/remote');
    assert.ok(!$('.slash-panel'));
  } finally {
    await m2.unmount();
  }
});

test('Remote Control on a harness that links the whole computer: the entry opens the side panel that asks, and links nothing itself', async () => {
  store.set({ harnessOf: { t1: 'codex' }, summaryOpen: false });
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.type('/remote');
    assert.equal(desc('Remote Control'), 'Turn it on in the side panel');
    assert.equal(row('Remote Control').querySelector('.add-panel-check'), null);
    await pick(m, 'remote-control', 'Remote Control');
    assert.equal(store.get().summaryOpen, true);
    assert.equal(all('remoteControl').length, 0);
    // a login that can't have it says so, and does nothing
    store.set({ summaryOpen: false });
    fx.chatCaps = {
      ...fx.chatCaps,
      remoteControl: { state: 'disabled', via: 'rpc', why: { layer: 'account', code: 'account.remoteControlNeedsChatGPT' } },
    };
    await m.rerender();
    await m.type('/remote');
    assert.match(desc('Remote Control')!, /signed-in ChatGPT account/);
    await pick(m, 'remote', 'Remote Control');
    assert.equal(store.get().summaryOpen, false);
  } finally {
    await m.unmount();
  }
});
