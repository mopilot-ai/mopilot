// Ask on a selection (#5359): the quotes at the head of a chat's draft are chips above the field, the field holds only the words typed under them, a send still carries one string, and an Ask takes the keyboard.
import assert from 'node:assert/strict';
import { useContext } from 'react';
import { afterEach, test } from 'node:test';
import { act, createElement, createRoot, flush, inputText, click } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
import { fakeDraft } from './support/phone/drafts';

const chipsPath = '../mobile/src/presentation/quoteChips';
const threadPath = '../mobile/src/screens/Thread';
const draftsPath = '../mobile/src/presentation/drafts';
const { splitDraft, joinDraft, chipText, withoutQuote } = await import(chipsPath);
const { Thread } = await import(threadPath);
const { createDraftStore } = await import(draftsPath);
const actionsPath = '../mobile/src/sideChat';
const replyPath = '../mobile/src/replyContext';
const { SelectionActions } = await import(actionsPath);
const { ReplyContext } = await import(replyPath);

const mounted: { root: any; host: HTMLElement }[] = [];
afterEach(async () => {
  for (const m of mounted.splice(0)) {
    await act(async () => m.root.unmount());
    m.host.remove();
  }
});

test('a draft splits into its leading quotes and the words under them, and joins back as it was', () => {
  assert.deepEqual(splitDraft(''), { quotes: [], typed: '' });
  assert.deepEqual(splitDraft('just words'), { quotes: [], typed: 'just words' });
  assert.deepEqual(splitDraft('> a\n\n'), { quotes: ['> a'], typed: '' });
  assert.deepEqual(splitDraft('> a\n> b\n\n> c\n\nmy note\nmore'), { quotes: ['> a\n> b', '> c'], typed: 'my note\nmore' });
  for (const full of ['', 'words', '> a\n\n', '> a\n\nnote', '> a\n\n> b\n\nnote']) {
    const { quotes, typed } = splitDraft(full);
    assert.equal(joinDraft(quotes, typed), full);
  }
});

test('words typed to begin like a quote stay words: they are stored behind a space and shown as typed', () => {
  for (const typed of ['> not a quote', '>', '> a\n\n']) {
    const full = joinDraft([], typed);
    assert.deepEqual(splitDraft(full), { quotes: [], typed }, `${JSON.stringify(typed)} typed alone`);
    const under = joinDraft(['> real'], typed);
    assert.deepEqual(splitDraft(under), { quotes: ['> real'], typed }, `${JSON.stringify(typed)} under a quote`);
  }
  // a quote that runs straight into other text is typed words, not a chip
  assert.deepEqual(splitDraft('> a\nrun on'), { quotes: [], typed: '> a\nrun on' });
});

test('a chip is its words on one line, and a quote leaves the draft alone but for itself', () => {
  assert.equal(chipText('> the total\n> multiplied  before'), 'the total multiplied before');
  assert.equal(chipText('> one\n>\n> two'), 'one two');
  assert.equal(withoutQuote('> a\n\n> b\n\nnote', 0), '> b\n\nnote');
  assert.equal(withoutQuote('> a\n\n> b\n\nnote', 1), '> a\n\nnote');
  assert.equal(withoutQuote('> a\n\nnote', 0), 'note');
  assert.equal(withoutQuote('> a\n\n', 0), '');
  assert.equal(withoutQuote('note', 3), 'note', 'no such quote: nothing changes');
});

async function open(draft: ReturnType<typeof fakeDraft>) {
  const rig = scripted((m) =>
    m === 'chat.follow'
      ? {
          rev: 1,
          feedSeq: 0,
          session: { turn: 'idle', cards: [] },
          itemsShape: 'rows',
          items: [{ role: 'assistant', text: 'hello there' }],
        }
      : undefined,
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(createElement(Thread, { runtime: rig.runtime, chatId: 'c', back: () => {}, drafts: draft })));
  await flush();
  return {
    field: () => document.querySelector('input[placeholder="Message this chat"]') as HTMLInputElement,
    chips: () => [...document.querySelectorAll('[aria-label^="Quoted: "]')].map((e) => e.textContent),
  };
}

test('the composer shows each leading quote as a chip and only the typed words in the field', async () => {
  const draft = fakeDraft('> the total\n\n> drifts\n\nwhy?');
  const v = await open(draft);
  assert.deepEqual(v.chips(), ['the total', 'drifts']);
  assert.equal(v.field().dataset.text, 'why?');
});

test('typing keeps the quotes, a quote chip’s × takes only that quote out, and the draft stays one string for the send', async () => {
  const draft = fakeDraft('> the total\n\n> drifts\n\n');
  const v = await open(draft);
  await inputText('Message this chat', 'is that right?');
  assert.equal(draft.text(), '> the total\n\n> drifts\n\nis that right?');
  await click('Remove quote');
  assert.equal(draft.text(), '> drifts\n\nis that right?', 'the first chip was taken out');
  assert.deepEqual(v.chips(), ['drifts']);
  assert.equal(v.field().dataset.text, 'is that right?');
});

test('words typed under no quote stay as typed, also when they begin with ">"', async () => {
  const draft = fakeDraft('');
  const v = await open(draft);
  await inputText('Message this chat', '> mine');
  assert.deepEqual(v.chips(), [], 'what was typed is not turned into a chip');
  assert.equal(v.field().dataset.text, '> mine');
});

test('an Ask draws the field again, which takes the keyboard; the draft store counts the asks per chat', async () => {
  const draft = fakeDraft('');
  const v = await open(draft);
  const before = v.field();
  assert.equal(before.dataset.autoFocus, 'false', 'a chat opened as it is does not take the keyboard');
  await act(async () => draft.focus!());
  assert.notEqual(v.field(), before, 'a new field is drawn for each Ask');
  assert.equal(v.field().dataset.autoFocus, 'true', 'and it takes the keyboard');
  // a chat opened after an Ask (the draft store remembers the count) does not pop the keyboard for it
  const later = await open(draft);
  assert.equal([...document.querySelectorAll('input[placeholder="Message this chat"]')].at(-1)!.getAttribute('data-auto-focus'), 'false');
  void later;
  const store = createDraftStore();
  const one = store.of('a');
  const other = store.of('b');
  let told = 0;
  one.subscribe!(() => told++);
  assert.equal(one.focusTick!(), 0);
  one.focus!();
  one.focus!();
  assert.equal(one.focusTick!(), 2);
  assert.equal(other.focusTick!(), 0, 'another chat’s composer is not asked');
  assert.equal(told, 2, 'each ask is told to the composer');
});

test('Ask on a selection puts the quote in the draft and asks the composer for the keyboard; a chat with no composer offers no Ask', async () => {
  const draft = fakeDraft('my note');
  let ask: ((selected: string) => void) | null = null;
  const Probe = () => ((ask = useContext(ReplyContext)), null);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  const render = (usable: boolean) =>
    act(async () =>
      root.render(
        createElement(
          SelectionActions,
          { drafts: draft, request: async () => ({}), chatId: 'c', hostId: undefined, controls: null, usable },
          createElement(Probe),
        ),
      ),
    );
  await render(true);
  assert.ok(ask);
  await act(async () => ask!('the total'));
  assert.equal(draft.text(), '> the total\n\nmy note');
  assert.equal(draft.focusTick!(), 1, 'the composer was asked once');
  await render(false);
  assert.equal(ask, null, 'a closed chat has no Ask');
});

test('a draft handle that cannot be asked for the keyboard (no focus tick) still draws a composer that never takes it', async () => {
  const bare = fakeDraft('> a\n\nnote');
  const handle = { get: bare.get, set: bare.set, clear: bare.clear, subscribe: bare.subscribe } as any;
  const v = await open(handle);
  assert.equal(v.field().dataset.autoFocus, 'false');
  assert.deepEqual(v.chips(), ['a']);
});
