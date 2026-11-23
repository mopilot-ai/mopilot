// The side panel's open chat (electron/chrome-extension/src/panelThread.mjs and its use in sidePanel.mjs): rows read from MoPilot, the reply streaming until the next read, follow-ups, and only the open chat's updates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick } from './support/extension-background/fixture.ts';
import { el, panelPage } from './support/side-panel-page.ts';

const { PanelThread, PROGRESS } = await import('../electron/chrome-extension/src/panelThread.mjs');
const { startSidePanel } = await import('../electron/chrome-extension/src/sidePanel.mjs');

/** A thread on a fake document; each read waits for the test to answer it. */
function thread() {
  const els: Record<string, any> = {};
  const document = {
    getElementById: (id: string) => (els[id] ??= el()),
    createElement: (tag: string) => el(tag),
    createTextNode: (text: string) => ({ textContent: text }),
  };
  const reads: { chatId: string; answer: (r: any) => void; fail: (e: Error) => void }[] = [];
  const errors: string[] = [];
  const t = new PanelThread({
    document,
    request: (_method: string, params: any) => new Promise((answer, fail) => reads.push({ chatId: params.chatId, answer, fail })),
    onError: (text: string) => errors.push(text),
    onOpen: () => undefined,
  });
  const shown = () => els.rows.children.map((c: any) => `${c.className}: ${c.textContent}`);
  return { t, els, reads, errors, shown };
}

test('a message just sent shows until MoPilot’s history has it; the reply streams until a read replaces it', async () => {
  const { t, els, reads, shown } = thread();
  const opened = t.open('c1', { sent: 'Top stories?' });
  assert.deepEqual(shown(), ['you: Top stories?']);
  // a mention in it reads as its name
  const { t: t2, shown: shown2, reads: reads2 } = thread();
  const mentioned = t2.open('c2', { sent: 'Summarize [Kyoto trip](session://c1)' });
  assert.deepEqual(shown2(), ['you: Summarize @Kyoto trip']);
  reads2[0].answer({ rows: [] });
  await mentioned;
  assert.equal(els['progress-text'].textContent, PROGRESS.running.text);
  // the harness hasn't written it yet: it stays
  reads[0].answer({ rows: [], omitted: false });
  await opened;
  assert.deepEqual(shown(), ['you: Top stories?']);
  t.delta('The top ');
  t.delta('three are');
  assert.equal(els.live.textContent, 'The top three are');
  assert.equal(els.live.hidden, false);
  // the read has the message (with the tab's line after it) and the reply as far as it was written: the preview keeps
  // only what follows, which streamed in while the read was out
  const again = t.read();
  t.delta(' A, B, C. Newer');
  reads[1].answer({
    rows: [
      // main reads the tab it was sent from apart from the message (shared/userText.mjs)
      { role: 'user', text: 'Top stories?', tab: 'https://news.ycombinator.com/item?id=1' },
      { role: 'step', text: 'Used navigate' },
      { role: 'note', text: 'Max limit reached on a@x.com. Continued on b@x.com' },
      { role: 'assistant', text: 'The top three are A, B, C.' },
    ],
    omitted: true,
    harness: 'Claude Code',
    account: 'b@x.com',
    model: 'sonnet',
    state: 'idle',
  });
  await again;
  assert.deepEqual(shown(), [
    'omitted: Earlier messages are in MoPilot.',
    'you: Top stories?news.ycombinator.com',
    'step: Used navigate',
    'note: Max limit reached on a@x.com. Continued on b@x.com',
    'reply: The top three are A, B, C.',
  ]);
  // the tab by its site, the whole address on hover
  const tab = els.rows.children[1].children.find((c: any) => c.className === 'tab');
  assert.deepEqual([tab.className, tab.title], ['tab', 'https://news.ycombinator.com/item?id=1']);
  assert.equal(els.live.textContent, 'Newer');
  // the harness and the account its turns run on now
  assert.equal(els.meta.textContent, 'Claude Code · b@x.com');
  assert.equal(els['progress-text'].textContent, 'Done');
  // a follow-up shows at once after the rows, its turn running
  t.sending('And the fourth?');
  assert.equal(shown().at(-1), 'you: And the fourth?');
  assert.equal(els['progress-text'].textContent, 'Working…');
  t.turn('nonsense');
  assert.equal(els['progress-text'].textContent, 'Working…');
  // an address that isn't one (not what main sends) shows as it is; a row of a role this panel doesn't know is a step
  t.render(
    [
      { role: 'user', text: 'x', tab: 'https://' },
      { role: 'later', text: 'y' },
    ],
    false,
  );
  assert.deepEqual(shown().slice(0, 2), ['you: xhttps://', 'step: y']);
  t.close();
  assert.deepEqual(shown(), []);
  await t.read();
  assert.equal(reads.length, 2, 'no chat, nothing to read');
});

test('changes during a read read once more after it; an answer for a chat no longer open is dropped; a failure is said', async () => {
  const { t, reads, errors, shown } = thread();
  const first = t.open('c1');
  void t.read();
  void t.read();
  assert.equal(reads.length, 1, 'one read at a time');
  reads[0].answer({ rows: [{ role: 'assistant', text: 'one' }] });
  await first;
  await tick();
  assert.equal(reads.length, 2, 'the changes during it: one more read');
  reads[1].answer({ rows: [{ role: 'assistant', text: 'two' }] });
  await tick();
  assert.deepEqual(shown(), ['reply: two']);
  // another chat opens while a read of the first is out: that answer is dropped, and the new chat is read after it
  void t.read();
  void t.open('c2');
  reads[2].answer({ rows: [{ role: 'assistant', text: 'of c1' }] });
  await tick();
  assert.deepEqual(shown(), []);
  assert.equal(reads.at(-1)?.chatId, 'c2');
  reads[3].answer({ rows: [{ role: 'assistant', text: 'of c2' }] });
  await tick();
  assert.deepEqual(shown(), ['reply: of c2']);
  // MoPilot refusing: the panel's error line
  const { t: u, reads: r2, errors: e2 } = thread();
  const failed = u.open('c3');
  r2[0].fail(new Error("That chat isn't in MoPilot."));
  await failed;
  assert.deepEqual(e2, ["That chat isn't in MoPilot."]);
  assert.deepEqual(errors, []);
});

test('the page: a recent chat opens in the panel on its own harness; a follow-up goes to it; only its updates show', async () => {
  let state = 'running';
  const p = panelPage({
    reply: (m: any) => {
      if (m.type !== 'panel') return { status: 'connected' };
      if (m.method === 'harnesses') return { status: 'connected', result: { harnesses: [{ id: 'claude', label: 'Claude Code' }] } };
      if (m.method === 'recent')
        return {
          status: 'connected',
          result: {
            chats: [
              { id: 'th-1', title: 'Flights', state: 'running' },
              { id: 'th-2', title: null, state: 'idle' },
            ],
          },
        };
      if (m.method === 'read')
        return {
          status: 'connected',
          result: { rows: [{ role: 'assistant', text: 'Searching…' }], harness: 'Codex', model: 'gpt-5.5', state },
        };
      return { status: 'connected', result: { sent: true } };
    },
  });
  await startSidePanel(p.g).ready;
  await tick();
  p.els.title.listeners.click({ isTrusted: true });
  await tick();
  p.els.recents.children[0].children[0].listeners.click({ isTrusted: true });
  await tick();
  await tick();
  assert.equal(p.els.title.textContent, 'Flights');
  assert.equal(p.els.meta.hidden, false);
  assert.equal(p.els.meta.textContent, 'Codex');
  // the reply streams; another chat's doesn't show here
  const event = (e: any) => p.chrome.runtime.onMessage.fire({ type: 'panelEvent', event: e });
  event({ kind: 'delta', chatId: 'th-1', text: 'Found 3' });
  event({ kind: 'delta', chatId: 'other', text: 'nope' });
  event({ kind: 'delta', chatId: 'th-1' });
  assert.equal(p.els.live.textContent, 'Found 3');
  const reads = () => p.sent().filter((m: any) => m.method === 'read').length;
  const before = reads();
  event({ kind: 'changed', chatId: 'th-1' });
  await tick();
  assert.equal(reads(), before + 1);
  event({ kind: 'turn', chatId: 'th-1', state: 'running' });
  await tick();
  assert.equal(reads(), before + 1, 'still running: nothing new to read');
  state = 'waiting';
  event({ kind: 'turn', chatId: 'th-1', state: 'waiting' });
  await tick();
  assert.equal(reads(), before + 2, 'it waits: its rows as they are');
  assert.equal(p.els['progress-text'].textContent, 'Waiting for you');
  event({ kind: 'turn', chatId: 'other', state: 'idle' });
  event({ kind: 'mystery', chatId: 'th-1' });
  // an update with nothing in it changes nothing
  p.chrome.runtime.onMessage.fire({ type: 'panelEvent' });
  // a follow-up, with the tab, to the open chat (no harness to pick)
  p.els.harness.value = '';
  p.els.text.value = 'Only nonstop ones';
  p.els.text.listeners.input();
  assert.equal(p.els.send.disabled, false);
  p.els.composer.listeners.submit({ preventDefault: () => undefined });
  await tick();
  assert.deepEqual(
    p.sent().find((m: any) => m.method === 'send'),
    {
      type: 'panel',
      method: 'send',
      params: { chatId: 'th-1', text: 'Only nonstop ones', tab: { id: 500, url: 'https://news.ycombinator.com/', title: 'Hacker News' } },
    },
  );
  assert.equal(p.els.text.value, '');
  assert.equal(p.els.rows.children.at(-1).textContent, 'Only nonstop ones');
  // New chat: the picker is back
  p.els.new.listeners.click({ isTrusted: true });
  assert.equal(p.els.meta.hidden, true);
  // with no chat open, a chat's updates go nowhere
  event({ kind: 'delta', chatId: 'th-1', text: 'late' });
  assert.equal(p.els.live.textContent, '');
  // a recent chat with no title yet opens as New chat
  p.els.title.listeners.click({ isTrusted: true });
  await tick();
  p.els.recents.children[1].children[0].listeners.click({ isTrusted: true });
  await tick();
  assert.equal(p.els.title.textContent, 'New chat');
  assert.deepEqual(
    p
      .sent()
      .filter((m: any) => m.method === 'read')
      .at(-1),
    { type: 'panel', method: 'read', params: { chatId: 'th-2' } },
  );
});

test('a follow-up shows the moment it is sent; one MoPilot refuses goes back to the box, with why', async () => {
  const p = panelPage({
    reply: (m: any) => {
      if (m.type !== 'panel') return { status: 'connected' };
      if (m.method === 'start') return { status: 'connected', result: { chatId: 'c1' } };
      if (m.method === 'send') return { status: 'connected', error: "That chat isn't in MoPilot." };
      if (m.method === 'harnesses') return { status: 'connected', result: { harnesses: [{ id: 'claude', label: 'Claude Code' }] } };
      return { status: 'connected', result: { rows: [], state: 'idle' } };
    },
  });
  await startSidePanel(p.g).ready;
  await tick();
  p.els.text.value = 'First';
  p.els.composer.listeners.submit({ preventDefault: () => undefined });
  await tick();
  await tick();
  const rows = () => p.els.rows.children.map((r: any) => r.textContent);
  p.els.text.value = 'Second';
  p.els.composer.listeners.submit({ preventDefault: () => undefined });
  // before MoPilot answers
  assert.deepEqual(rows(), ['First', 'Second']);
  assert.equal(p.els.text.value, '');
  await tick();
  await tick();
  assert.deepEqual(rows(), ['First']);
  assert.equal(p.els.text.value, 'Second');
  assert.equal(p.els.error.textContent, "That chat isn't in MoPilot.");
});

test('a request waiting for the user: its choices answer it in the panel, or it opens in MoPilot; Stop while it runs', async () => {
  let state = 'waiting';
  let answerError: string | null = null;
  let stopError: string | null = null;
  const cards = [
    {
      id: 's1',
      title: 'Allow Codex to use https://a.example in your Chrome?',
      detail: 'https://a.example',
      choices: [
        { key: 'once', label: 'Allow once' },
        { key: 'deny', label: 'Deny', deny: true },
      ],
    },
    { id: 7, title: 'Codex is waiting for you in MoPilot.', inApp: true },
    { id: 8, choices: 'not a list' },
  ];
  const p = panelPage({
    reply: (m: any) => {
      if (m.type !== 'panel') return { status: 'connected' };
      if (m.method === 'harnesses') return { status: 'connected', result: { harnesses: [{ id: 'codex', label: 'Codex' }] } };
      if (m.method === 'start') return { status: 'connected', result: { chatId: 'th-1' } };
      if (m.method === 'answer')
        return answerError ? { status: 'connected', error: answerError } : { status: 'connected', result: { answered: true } };
      if (m.method === 'stop')
        return stopError ? { status: 'connected', error: stopError } : { status: 'connected', result: { stopped: true } };
      if (m.method === 'read') return { status: 'connected', result: { rows: [], state, approvals: state === 'waiting' ? cards : [] } };
      return { status: 'connected', result: {} };
    },
  });
  await startSidePanel(p.g).ready;
  await tick();
  p.els.text.value = 'Open a.example';
  p.els.composer.listeners.submit({ preventDefault: () => undefined });
  await tick();
  await tick();
  await tick();
  const shown = p.els.cards.children;
  assert.equal(shown.length, 3);
  assert.deepEqual(
    shown[0].children.map((c: any) => (c.className === 'choices' ? c.className : c.textContent)),
    ['Allow Codex to use https://a.example in your Chrome?', 'https://a.example', 'choices'],
  );
  const choices = shown[0].children[2].children;
  assert.deepEqual(
    choices.map((b: any) => [b.textContent, b.className]),
    [
      ['Allow once', 'primary'],
      ['Deny', ''],
    ],
  );
  assert.equal(shown[2].children.at(-1).children.length, 0, 'a card without a list of choices offers none');
  // the waiting chat: the button is Send (Stop is for a running turn)
  assert.equal(p.els.stop.hidden, true);
  // a choice: its key goes to MoPilot, then the chat is read again
  state = 'running';
  choices[0].listeners.click({ isTrusted: true });
  assert.equal(choices[0].disabled, true, 'one answer');
  await tick();
  await tick();
  assert.deepEqual(
    p.sent().find((m: any) => m.method === 'answer'),
    { type: 'panel', method: 'answer', params: { chatId: 'th-1', approvalId: 's1', choice: 'once' } },
  );
  assert.equal(p.els.cards.children.length, 0);
  // running with the box empty: Stop; typing a follow-up: Send again
  assert.equal(p.els.stop.hidden, false);
  assert.equal(p.els.send.hidden, true);
  p.els.text.value = 'and more';
  p.els.text.listeners.input();
  assert.equal(p.els.stop.hidden, true);
  p.els.text.value = '';
  p.els.text.listeners.input();
  p.els.stop.listeners.click({ isTrusted: true });
  await tick();
  await tick();
  assert.deepEqual(
    p
      .sent()
      .filter((m: any) => m.method === 'stop')
      .at(-1),
    { type: 'panel', method: 'stop', params: { chatId: 'th-1' } },
  );
  stopError = "That chat isn't in MoPilot.";
  p.els.stop.listeners.click({ isTrusted: true });
  await tick();
  await tick();
  assert.equal(p.els.error.textContent, "That chat isn't in MoPilot.");
  // a card answered elsewhere meanwhile: why, and the chat as it is now
  state = 'waiting';
  void p.chrome.runtime.onMessage.fire({ type: 'panelEvent', event: { kind: 'turn', chatId: 'th-1', state: 'waiting' } });
  await tick();
  await tick();
  answerError = 'That request was already answered.';
  p.els.cards.children[0].children[2].children[1].listeners.click({ isTrusted: true });
  await tick();
  await tick();
  assert.equal(p.els.error.textContent, 'That request was already answered.');
  // a card the panel doesn't answer opens the chat in MoPilot
  p.els.cards.children[1].children.at(-1).children[0].listeners.click({ isTrusted: true });
  await tick();
  assert.deepEqual(
    p
      .sent()
      .filter((m: any) => m.method === 'open')
      .at(-1),
    { type: 'panel', method: 'open', params: { chatId: 'th-1' } },
  );
  // no chat open: neither Stop nor a card's button does anything
  const button = p.els.cards.children[1].children.at(-1).children[0];
  const choice = p.els.cards.children[0].children[2].children[0];
  // (a new chat reads its menus and the greeting's tasks, nothing else)
  const acts = () => p.sent().filter((m: any) => m.method !== 'options' && m.method !== 'scheduled').length;
  const count = acts();
  p.els.new.listeners.click({ isTrusted: true });
  button.listeners.click({ isTrusted: true });
  choice.listeners.click({ isTrusted: true });
  p.els.stop.listeners.click({ isTrusted: true });
  await tick();
  assert.equal(acts(), count);
});

test('a running turn’s streamed reply stays until a read of the chat holds it, on a harness whose history has no reply yet (#2116)', async () => {
  const { t, els, reads } = thread();
  const opened = t.open('c1', { sent: 'Keep going SLOW' });
  reads[0].answer({ rows: [], state: 'running' });
  await opened;
  t.delta('fake-claude: Keep going SLOW');
  // Claude Code's transcript has the message but not the reply still streaming: the preview stays
  const user = { role: 'user', text: 'Keep going SLOW' };
  const first = t.read();
  reads[1].answer({ rows: [user], state: 'running' });
  await first;
  assert.equal(els.live.textContent, 'fake-claude: Keep going SLOW');
  assert.equal(els.live.hidden, false);
  // a step, then the next message streams: the read that has the first as a row keeps only the rest
  t.delta(' Then the next part.');
  const second = t.read();
  reads[2].answer({
    rows: [user, { role: 'assistant', text: 'fake-claude:\nKeep going SLOW' }, { role: 'step', text: 'Ran ls' }],
    state: 'running',
  });
  await second;
  assert.equal(els.live.textContent, 'Then the next part.');
  // Codex's read holds the reply as it is being written: nothing is shown twice
  const third = t.read();
  reads[3].answer({
    rows: [user, { role: 'assistant', text: 'fake-claude: Keep going SLOW Then the next part. And more' }],
    state: 'running',
  });
  await third;
  assert.equal(els.live.textContent, '');
  assert.equal(els.live.hidden, true);
  // the turn ended (its update, then a read) without its end in the history (stopped, or not written yet): it stays
  t.delta(' And more cut off');
  const done = [user, { role: 'assistant', text: 'fake-claude: Keep going SLOW' }];
  t.turn('idle');
  const fourth = t.read();
  reads[4].answer({ rows: done, state: 'idle' });
  await fourth;
  assert.equal(els.live.textContent, 'Then the next part. And more cut off');
  // a turn started in the app: a reply of its own
  t.turn('running');
  assert.equal(els.live.textContent, '');
  assert.equal(els.live.hidden, true);
  t.delta('Second turn');
  // an approval, then the turn goes on: the same reply; a read that answers late, saying idle, starts nothing
  t.turn('waiting');
  const fifth = t.read();
  reads[5].answer({ rows: done, state: 'idle' });
  await fifth;
  t.turn('running');
  assert.equal(els.live.textContent, 'Second turn');
  // a follow-up steered into the turn: the turn's reply goes on across it
  const app = { role: 'user', text: 'Second' };
  t.delta(' goes on');
  const steered = t.read();
  reads[6].answer({
    rows: [...done, app, { role: 'assistant', text: 'Second' }, { role: 'user', text: 'Also this' }, { role: 'assistant', text: 'turn' }],
    state: 'running',
  });
  await steered;
  assert.equal(els.live.textContent, 'goes on');
  // a follow-up sent from here isn't in the rows yet: they end with the turn before it, whose words prove nothing
  t.turn('idle');
  t.sending('Again please');
  t.delta('fake-claude: Keep');
  const sixth = t.read();
  reads[7].answer({ rows: done, state: 'running' });
  await sixth;
  assert.equal(els.live.textContent, 'fake-claude: Keep');
  // and New chat starts from nothing
  t.close();
  assert.equal(els.live.textContent, '');
});

test('a chat opened while its turn runs: the reply streamed since is what follows the rows’ (#2116)', async () => {
  const { t, els, reads } = thread();
  const opened = t.open('c1');
  t.delta('half of the second message');
  const user = { role: 'user', text: 'Go' };
  reads[0].answer({ rows: [user, { role: 'assistant', text: 'First. Then the first half of the second message' }], state: 'running' });
  await opened;
  assert.equal(els.live.textContent, '', 'Codex: the rows hold it');
  // Claude Code: the second message is written while the third streams
  t.delta(' and the third');
  const again = t.read();
  reads[1].answer({ rows: [user, { role: 'assistant', text: 'First. Then the first half of the second message' }], state: 'running' });
  await again;
  assert.equal(els.live.textContent, 'and the third');
  // a follow-up sent from here while it runs goes into the same turn: the rows still hold the reply's start
  t.sending('More please');
  const steer = t.read();
  reads[2].answer({ rows: [user, { role: 'assistant', text: 'First. Then the first half of the second message' }], state: 'running' });
  await steer;
  assert.equal(els.live.textContent, 'and the third');
  // a stopped read that says idle, then the next turn: from its start again
  t.turn('idle');
  t.turn('running');
  t.delta('Next');
  const next = t.read();
  reads[3].answer({ rows: [user, { role: 'assistant', text: 'something else entirely, Next' }], state: 'running' });
  await next;
  assert.equal(els.live.textContent, 'Next', 'not joined mid-way any more: the rows end with another reply');
});
