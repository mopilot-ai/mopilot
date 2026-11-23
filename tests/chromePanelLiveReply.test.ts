// The Chrome side panel's streamed reply drawn as a row draws it, and a message sent again (electron/chrome-extension/src/panelThread.mjs): Markdown while it streams, room for Copy, and a repeat of an earlier message shown until its own row is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { el } from './support/side-panel-page.ts';

const { PanelThread, BIG_REPLY, LIVE_MS } = await import('../electron/chrome-extension/src/panelThread.mjs');
const { markdown } = await import('../electron/chrome-extension/src/panelMarkdown.mjs');

/** A thread on a fake document; each read waits for the test to answer it. */
function thread(timers?: any) {
  const els: Record<string, any> = {};
  const document = {
    getElementById: (id: string) => (els[id] ??= el()),
    createElement: (tag: string) => el(tag),
    createTextNode: (text: string) => ({ textContent: text }),
  };
  const reads: ((r: any) => void)[] = [];
  const t = new PanelThread({
    document,
    request: () => new Promise((answer) => reads.push(answer)),
    onError: () => undefined,
    onOpen: () => undefined,
    timers,
  });
  const you = () =>
    els.rows.children
      .filter((c: any) => c.className === 'you')
      .map((c: any) => c.children.find((k: any) => k.className === 'tab') ?? c.text);
  return { t, els, reads, you };
}
const user = (text: string) => ({ role: 'user', text });
const reply = (text: string) => ({ role: 'assistant', text });
/** A node's tag and children, text as itself (the Copy buttons are not content). */
const shape = (n: any): any =>
  n.tagName
    ? { [n.tagName.toLowerCase()]: n.children.length ? n.children.filter((c: any) => c.className !== 'message-copy').map(shape) : n.text }
    : n.textContent;
const content = (node: any) => node.children.filter((c: any) => c.className !== 'message-copy').map(shape);

const TEXT = '## Plan\n\n- one\n  - nested\n\n> quoted\n\nA `snippet` and **bold**.';

test('the streamed reply is Markdown from its first word, the same nodes the row draws once a read holds it', () => {
  const { t, els } = thread();
  t.delta(TEXT.slice(0, 20));
  assert.equal(els.live.hidden, false);
  // the heading is a heading while the rest streams
  assert.equal(els.live.children[0].attrs.role, 'heading');
  t.delta(TEXT.slice(20));
  const streamed = content(els.live);
  t.render([reply(TEXT)], false);
  const row = els.rows.children[0];
  assert.deepEqual(streamed, content(row));
  assert.deepEqual(streamed, markdown({ createElement: el, createTextNode: (x: string) => ({ textContent: x }) }, TEXT).map(shape));
  // both end with a Copy (the stylesheet shows the row's only), so the read moves nothing
  assert.equal(els.live.children.at(-1).className, 'message-copy');
  assert.equal(row.children.at(-1).className, 'message-copy');
});

test('the reply is drawn once per change and not again for the same text', () => {
  const { t, els } = thread();
  t.delta('Hello');
  const before = [...els.live.children];
  t.render([], false);
  assert.deepEqual(els.live.children, before);
  t.delta(' there');
  assert.notDeepEqual(els.live.children, before);
  // a turn of its own starts from nothing, and an empty reply is hidden
  t.newReply();
  assert.equal(els.live.hidden, true);
  assert.equal(content(els.live).length, 0);
});

test('a message sent again shows at once and until the rows hold one more copy of it', async () => {
  const { t, els, reads, you } = thread();
  const opened = t.open('c1');
  reads[0]({ rows: [user('Q'), reply('A')], state: 'idle' });
  await opened;
  assert.equal(you().length, 1);
  // the same message again: shown, though the rows hold a copy already
  t.sending('Q');
  assert.equal(you().length, 2);
  // a read before the harness wrote it still shows it; one holding it twice does not show it a third time
  const stale = t.read();
  reads[1]({ rows: [user('Q'), reply('A')], state: 'running' });
  await stale;
  assert.equal(you().length, 2);
  const written = t.read();
  reads[2]({ rows: [user('Q'), reply('A'), user('Q')], state: 'running' });
  await written;
  assert.equal(you().length, 2);
  assert.deepEqual(t.sent, []);
  assert.equal(els.rows.children.filter((c: any) => c.className === 'you').length, 2);
});

test('two copies queued before either is written clear one at a time, and a refused one leaves the other', async () => {
  const { t, reads, you } = thread();
  const opened = t.open('c1');
  reads[0]({ rows: [user('Q'), reply('A')], state: 'idle' });
  await opened;
  t.sending('Q');
  t.sending('Q');
  assert.equal(you().length, 3);
  const one = t.read();
  reads[1]({ rows: [user('Q'), reply('A'), user('Q')], state: 'running' });
  await one;
  assert.equal(you().length, 3);
  assert.deepEqual([t.sent, t.seen], [['Q'], [2]]);
  t.unsent('Q');
  assert.equal(you().length, 2);
  assert.deepEqual([t.sent, t.seen], [[], []]);
});

test('with older rows left out a copy in the rows is the message, as before counts', async () => {
  const { t, reads, you } = thread();
  const opened = t.open('c1');
  reads[0]({ rows: [user('Q'), reply('A')], omitted: true, state: 'idle' });
  await opened;
  t.sending('Q');
  assert.equal(you().length, 1);
});

test('a reply that starts like the one before is not hidden while the message that asked for it is not in the rows yet', async () => {
  const { t, els, reads } = thread();
  const opened = t.open('c1');
  reads[0]({ rows: [user('Q'), reply('The answer is 42, as before.')], state: 'idle' });
  await opened;
  t.sending('Q');
  t.delta('The answer is 42');
  const again = t.read();
  // the rows still end with the turn before; its reply is not this one's
  reads[1]({ rows: [user('Q'), reply('The answer is 42, as before.')], state: 'running' });
  await again;
  assert.equal(els.live.textContent, 'The answer is 42');
  assert.equal(els.live.hidden, false);
  // the harness wrote the message and a part of the reply: the live text is what follows it
  const written = t.read();
  t.delta(', as before. And more');
  reads[2]({ rows: [user('Q'), reply('The answer is 42, as before.'), user('Q'), reply('The answer is 42')], state: 'running' });
  await written;
  assert.equal(els.live.textContent, ', as before. And more');
});

test('a long reply is redrawn on a timer, not on every word, and the text catches up with it', () => {
  const due: { f: () => void; ms: number }[] = [];
  const { t, els } = thread({
    setTimeout: (f: () => void, ms: number) => (due.push({ f, ms }), due.length),
    clearTimeout: () => undefined,
  });
  t.delta('a'.repeat(BIG_REPLY));
  // up to the limit every word is drawn at once
  assert.equal(due.length, 0);
  assert.equal(els.live.textContent, 'a'.repeat(BIG_REPLY));
  // past it the draw waits one timer, however many words come meanwhile
  t.delta('b');
  t.delta('c');
  assert.deepEqual(
    due.map((d) => d.ms),
    [LIVE_MS],
  );
  assert.equal(els.live.textContent, 'a'.repeat(BIG_REPLY));
  due[0].f();
  assert.equal(els.live.textContent, `${'a'.repeat(BIG_REPLY)}bc`);
  // the next word starts the next wait
  t.delta('d');
  assert.equal(due.length, 2);
  due[1].f();
  assert.equal(els.live.textContent.endsWith('bcd'), true);
});
