// ↑/↓ prompt history in the composer (src/components/composer/useComposerHistory.ts): recall, the "History n/N" line,
// prompts read from the chat's transcript after a remount, and no history carried into another chat.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, fire } from './support/composer-kit.ts';
import { mountComposer, reset, settle, store } from './support/composer-setup.ts';
import { resetPromptHistory } from '../src/lib/promptHistory.ts';

beforeEach(() => {
  reset();
  resetPromptHistory();
});
const W = window as any;
const label = () => $('.composer-history')?.textContent ?? null;
const prompt = (text: string) => ({ type: 'userMessage', id: text, clientId: null, content: [{ type: 'text', text, text_elements: [] }] });
const withTranscript = (id: string, ...texts: string[]) =>
  store.set((s: any) => ({ runtime: { ...s.runtime, [id]: { turns: texts.map((t) => ({ id: `turn-${t}`, items: [prompt(t)] })) } } }));

test('history: ↑ on an empty box recalls earlier messages, ↓ steps forward, editing stops it', async () => {
  const m = await mountComposer({ threadId: 't1' });
  try {
    for (const t of ['one', 'two']) {
      await m.type(t);
      await m.key('Enter');
      await settle();
    }
    assert.equal(label(), null);
    assert.equal(await m.key('ArrowUp'), true);
    assert.equal(m.text, 'two');
    assert.equal(label(), 'History 2/2');
    await m.key('ArrowUp');
    assert.equal(m.text, 'one');
    assert.equal(label(), 'History 1/2');
    assert.equal(await m.key('ArrowUp'), false, 'no older message');
    await m.key('ArrowDown');
    assert.equal(m.text, 'two');
    await m.key('ArrowDown');
    assert.equal(m.text, '');
    assert.equal(label(), null);
    assert.equal(await m.key('ArrowDown'), false);
    await m.key('ArrowUp');
    await m.type('two edited');
    assert.equal(label(), null, 'an edited prompt is no longer a recalled one');
    assert.equal(await m.key('ArrowUp'), false);
    assert.equal(await m.key('ArrowDown'), false);
  } finally {
    await m.unmount();
  }
});

test("an opened chat recalls its transcript's prompts, after a remount too", async () => {
  withTranscript('t1', 'first', 'second');
  for (let i = 0; i < 2; i++) {
    const m = await mountComposer({ threadId: 't1' });
    try {
      await m.key('ArrowUp');
      assert.equal(m.text, 'second');
      assert.equal(label(), 'History 2/2');
      await m.key('ArrowUp');
      assert.equal(m.text, 'first');
      assert.equal(label(), 'History 1/2');
      // back to an empty box, so no recalled prompt is kept as the draft
      await m.key('ArrowDown');
      await m.key('ArrowDown');
      assert.equal(m.text, '');
    } finally {
      await m.unmount();
    }
  }
});

test("another chat steps through its own prompts, never the last chat's", async () => {
  withTranscript('t1', 'in one');
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.key('ArrowUp');
    assert.equal(m.text, 'in one');
    await m.rerender({ threadId: 't2' });
    assert.equal(label(), null);
    assert.equal(await m.key('ArrowUp'), false, 't2 has no prompts');
    withTranscript('t2', 'in two');
    await m.key('ArrowUp');
    assert.equal(m.text, 'in two');
    assert.equal(label(), 'History 1/1');
  } finally {
    await m.unmount();
  }
});

test('a modified arrow is the caret’s, not the history’s', async () => {
  withTranscript('t1', 'kept');
  const m = await mountComposer({ threadId: 't1' });
  try {
    for (const mod of ['shiftKey', 'altKey', 'metaKey', 'ctrlKey']) assert.equal(await m.key('ArrowUp', { [mod]: true }), false);
    assert.equal(m.text, '');
  } finally {
    await m.unmount();
  }
});

test('history is not recalled over an attached skill', async () => {
  const m = await mountComposer({ threadId: null });
  try {
    await m.type('sent');
    await m.key('Enter');
    await settle();
    await fire(window, new W.CustomEvent('insert-skill', { detail: { name: 'ship', path: '/s/SKILL.md', displayName: 'Ship' } }));
    assert.equal(await m.key('ArrowUp'), false);
  } finally {
    await m.unmount();
  }
});

test('the new-chat composer steps through what was sent from any composer', async () => {
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.type('asked in a chat');
    await m.key('Enter');
    await settle();
    await m.rerender({ threadId: null });
    assert.equal(await m.key('ArrowUp'), true);
    assert.equal(m.text, 'asked in a chat');
    assert.equal(label(), 'History 1/1');
  } finally {
    await m.unmount();
  }
});
