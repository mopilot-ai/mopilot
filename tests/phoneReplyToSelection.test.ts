// Reply on a selection (#4837): the selected words become a quote in the chat's composer, offered only where the chat has a composer, and a long selection is cut.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { act, createElement, createRoot } from './support/phone/component-kit';

const require = createRequire(new URL('../mobile/package.json', import.meta.url));
const g = globalThis as any;
function FakeNative(props: any) {
  (g.__nativeRuns ??= []).push(props);
  return createElement('div', { 'data-native-run': props.runs.map((r: any) => r.t).join('') });
}
mock.module(require.resolve('expo'), { namedExports: { requireNativeView: () => FakeNative } });
const nativePath = '../mobile/src/platform/selectableTextNative';
const flagPath = '../mobile/src/platform/inPlaceSelection';
const bubblePath = '../mobile/src/components/MessageBubble';
const replyPath = '../mobile/src/replyContext';
await import(nativePath);
const { setInPlaceSelection } = await import(flagPath);
const { MessageBubble } = await import(bubblePath);
const { QUOTE_MAX, quoteOf, withQuote, ReplyContext } = await import(replyPath);

async function mount(node: any) {
  document.body.replaceChildren();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return () => act(async () => root.unmount());
}
const lastRun = () => (g.__nativeRuns as any[]).at(-1);

test('the quote has "> " before each line, a bare ">" for a blank line, and nothing for nothing', () => {
  assert.equal(quoteOf('one\ntwo'), '> one\n> two');
  assert.equal(quoteOf('one\n\ntwo'), '> one\n>\n> two');
  assert.equal(quoteOf('  words  \r\nmore'), '> words\n> more');
  assert.equal(quoteOf('   \n '), '');
  assert.equal(quoteOf('one\u2028two'), '> one\n> two', 'a line separator inside a run’s paragraph is a line');
});

test('a long selection is cut with an ellipsis', () => {
  const quote = quoteOf('a'.repeat(QUOTE_MAX + 50));
  assert.equal(quote, `> ${'a'.repeat(QUOTE_MAX)}…`);
});

test('the quote goes ahead of what is already typed, under a blank line, and the same quote is not added twice', () => {
  assert.equal(withQuote('', 'x y'), '> x y\n\n');
  assert.equal(withQuote('   ', 'x y'), '> x y\n\n');
  assert.equal(withQuote('my answer', 'x y'), '> x y\n\nmy answer');
  assert.equal(withQuote('> x y\n\nmy answer', 'x y'), '> x y\n\nmy answer');
  assert.equal(withQuote('my answer', '  '), 'my answer');
  // a second selection goes after the first and still ahead of the typed words, so the stack reads in the order it was taken
  assert.equal(withQuote('> a\n\nnote', 'b'), '> a\n\n> b\n\nnote');
  assert.equal(withQuote(withQuote('', 'the'), 'total'), '> the\n\n> total\n\n');
  assert.equal(withQuote('> a\n\n> b\n\nnote', 'a'), '> a\n\n> b\n\nnote', 'any quote already in the stack is not added again');
  assert.equal(withQuote('> a\nrun on', 'b'), '> b\n\n> a\nrun on', 'a ">" line that runs into text is the typed words, not a quote');
});

test('a reply in a chat with a composer offers Reply before Copy message, which hands the selected words over; without one it offers only Copy message', async () => {
  setInPlaceSelection(true);
  try {
    g.__nativeRuns = [];
    const seen: string[] = [];
    let done = await mount(
      createElement(
        ReplyContext.Provider,
        { value: (s: string) => seen.push(s) },
        createElement(MessageBubble, { role: 'assistant', text: 'Hello world' }),
      ),
    );
    const entries = lastRun().menuEntries;
    assert.deepEqual(
      entries.map((e: any) => e.id),
      ['ask', 'copyMessage', 'selectText'],
    );
    assert.equal(entries[0].selection, '1', 'a selection action is not offered to VoiceOver, which has no selection');
    assert.equal(entries[0].title, 'Ask');
    assert.equal(entries[0].first, '1', 'Ask is drawn ahead of the system’s Copy, as ChatGPT’s is');
    assert.equal(entries[1].selection, undefined);
    assert.equal(entries[1].first, undefined, 'the other entries follow the system’s');
    lastRun().onMenuAction({ nativeEvent: { id: 'ask', text: 'world' } });
    lastRun().onMenuAction({ nativeEvent: { id: 'ask' } });
    assert.deepEqual(seen, ['world', ''], 'an event with no text hands over nothing (the draft keeps what it has)');
    await done();
    g.__nativeRuns = [];
    done = await mount(createElement(MessageBubble, { role: 'assistant', text: 'Hello world' }));
    assert.deepEqual(
      lastRun().menuEntries.map((e: any) => e.id),
      ['copyMessage', 'selectText'],
    );
    await done();
  } finally {
    setInPlaceSelection(false);
  }
});

test('your own message that starts with a quote draws the quote as a block above your words, with no ">" left in it', async () => {
  const done = await mount(createElement(MessageBubble, { role: 'user', text: '> picked words\n\nmy answer' }));
  const text = document.body.textContent!;
  assert.ok(text.includes('picked words') && text.includes('my answer'));
  assert.ok(!text.includes('>'));
  await done();
  // a quote with no words under it is the quote alone, with no space left for words
  const alone = await mount(createElement(MessageBubble, { role: 'user', text: '> only the quote' }));
  assert.equal(document.body.textContent, 'only the quote');
  await alone();
  const plain = await mount(createElement(MessageBubble, { role: 'user', text: 'a > b' }));
  assert.equal(document.body.textContent, 'a > b');
  await plain();
});
