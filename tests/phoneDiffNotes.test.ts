// Notes on diff lines: written with a tap, kept until sent, and sent as one follow-up message in the diff-comment form; the diff stays read-only.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, createElement, createRoot, flush, inputText } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
import { parseDiffComments } from '../shared/diffComments.mjs';
import { parseUserText } from '../shared/userText.mjs';
const reviewPath = '../mobile/src/screens/Review';
const notesPath = '../mobile/src/remote/review';
const { Review } = await import(reviewPath);
const notes = await import(notesPath);

const row = (k: string, t: string, id = 0) => ({ id, k, t }) as any;
test('a note names its line, side and quoted line, and is trimmed and cut', () => {
  assert.deepEqual(notes.lineNote('a.ts', row('add', 'let x'), 3, '  Why?  '), {
    path: 'a.ts',
    side: 'R',
    line: 3,
    hunk: '+let x',
    text: 'Why?',
  });
  assert.deepEqual(notes.lineNote('a.ts', row('del', 'let y'), 2, 'Gone'), {
    path: 'a.ts',
    side: 'L',
    line: 2,
    hunk: '-let y',
    text: 'Gone',
  });
  assert.equal(notes.lineNote('a.ts', row('ctx', 'same'), 1, 'x').hunk, ' same');
  const long = notes.lineNote('a.ts', row('add', 'x'.repeat(900)), 1, 'y'.repeat(2000));
  assert.equal(long.hunk.length, 400);
  assert.ok(long.hunk.endsWith('…'), 'a cut quote says so');
  assert.equal(long.text.length, notes.NOTE_CHARS);
  assert.equal(notes.sideOf(row('del', '')), 'L');
  assert.equal(notes.sideOf(row('ctx', '')), 'R');
});

test('notes are added, replaced by line, removed when emptied, and capped', () => {
  const a = notes.lineNote('a.ts', row('add', 'x'), 1, 'one');
  const b = notes.lineNote('a.ts', row('del', 'y'), 1, 'two');
  let list = notes.setNote([], a);
  list = notes.setNote(list, b);
  assert.deepEqual(
    list.map((n: any) => [n.side, n.text]),
    [
      ['R', 'one'],
      ['L', 'two'],
    ],
    'the same number on the other side is another line',
  );
  list = notes.setNote(list, { ...a, text: 'again' });
  assert.deepEqual(
    list.map((n: any) => n.text),
    ['two', 'again'],
  );
  assert.deepEqual(
    notes.setNote(list, { ...a, text: '' }).map((n: any) => n.text),
    ['two'],
  );
  assert.deepEqual(notes.setNote([], { ...a, text: '' }), []);
  const full = Array.from({ length: notes.MOST_NOTES }, (_, i) => notes.lineNote('f.ts', row('add', 'x'), i + 1, `n${i}`));
  assert.equal(notes.setNote(full, notes.lineNote('f.ts', row('add', 'x'), 99, 'late')), full, 'a full list takes no new line');
  assert.equal(notes.setNote(full, { ...full[0], text: 'changed' }).length, notes.MOST_NOTES, 'but an old line can still be changed');
  assert.equal(notes.setNote(full, { ...full[0], text: '' }).length, notes.MOST_NOTES - 1);
});

test('the message is the diff-comment section every agent reads, with one request line', () => {
  const list = [
    notes.lineNote('src/a.ts', row('add', 'const a = 2;'), 3, 'Cap this at 1?'),
    notes.lineNote('src/a.ts', row('del', 'const a = 1;'), 2, '## Why?'),
  ];
  const text = notes.notesMessage(list);
  assert.match(text, /# Diff comments:/);
  assert.match(text, /## My request:\nAddress these notes on the changes\./);
  const back = parseUserText(text);
  assert.equal(back.text, notes.NOTES_REQUEST);
  assert.deepEqual(
    back.annotations.map((a: any) => [a.file.path, a.file.side, a.file.lines, a.annotation]),
    [
      ['src/a.ts', 'R', '3', 'Cap this at 1?'],
      ['src/a.ts', 'L', '2', '## Why?'],
    ],
  );
  assert.equal(parseDiffComments('').length, 0);
});

test('kept notes belong to one connection and chat and go when emptied', () => {
  const owner = {};
  const n = [notes.lineNote('a.ts', row('add', 'x'), 1, 'keep')];
  assert.deepEqual(notes.keptNotes(owner, 'c'), []);
  notes.keepNotes(owner, 'c', n);
  assert.equal(notes.keptNotes(owner, 'c'), n);
  assert.deepEqual(notes.keptNotes(owner, 'd'), []);
  assert.deepEqual(notes.keptNotes({}, 'c'), []);
  notes.keepNotes(owner, 'c', []);
  assert.deepEqual(notes.keptNotes(owner, 'c'), []);
});

const mounted: { root: any; host: HTMLElement }[] = [];
afterEach(async () => {
  for (const m of mounted.splice(0)) {
    await act(async () => m.root.unmount());
    m.host.remove();
  }
});
const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ k: 'add', t: `line ${i + 1}` }));
const diff = [
  { k: 'hunk', t: '@@ -1,3 +1,3 @@' },
  { k: 'ctx', t: 'keep' },
  { k: 'del', t: 'const a = 1;' },
  { k: 'add', t: 'const a = 2;' },
];
async function open(
  rows: any[] = diff,
  over: (m: string, p: any) => unknown = () => undefined,
  send?: (chat: string, text: string) => string,
) {
  const rig = scripted((m, p) => {
    if (m === 'diff.list') return { files: [{ path: 'src/a.ts', status: 'modified', binary: false, added: 1, removed: 1 }] };
    if (m === 'diff.read') return over(m, p) ?? { binary: false, rows, next: null, total: rows.length };
    return over(m, p);
  });
  const sent: [string, string][] = [];
  rig.runtime.send = (chat: string, text: string) => (send ? send(chat, text) : (sent.push([chat, text]), 'id'));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  let backs = 0;
  const render = (chatId = 'c') =>
    act(async () => root.render(createElement(Review, { runtime: rig.runtime, chatId, back: () => backs++ })));
  await render();
  await flush();
  const view = async () => {
    await act(async () => button(host, /^View diff/)!.click());
    await flush();
  };
  await view();
  return { host, sent, render, backs: () => backs, root, runtime: rig.runtime };
}
const button = (host: HTMLElement, label: RegExp) =>
  [...host.querySelectorAll('button')].find((b) => label.test(b.getAttribute('aria-label') ?? ''));
const press = async (host: HTMLElement, label: RegExp) => {
  const b = button(host, label);
  assert.ok(b, `a button ${label}`);
  await act(async () => b.click());
};
const write = async (host: HTMLElement, text: string) => {
  await inputText('Note for the agent', text);
};

test('a tap on a line opens a field; saving shows the note under the line and offers to send it', async () => {
  const { host } = await open();
  // only lines with a known number take a tap; hunk headers do not
  assert.equal(button(host, /@@/), undefined);
  assert.ok(button(host, /^Line 1: keep/));
  assert.ok(button(host, /^Removed, line 2: const a = 1;/));
  await press(host, /^Added, line 2: const a = 2;/);
  assert.ok(host.querySelector('input[placeholder="Note for the agent"]'));
  assert.equal(button(host, /^Save note$/)!.getAttribute('aria-disabled'), 'true', 'an empty note cannot be saved');
  await write(host, 'Cap this at 1?');
  await press(host, /^Save note$/);
  assert.equal(host.querySelector('input[placeholder="Note for the agent"]'), null);
  assert.ok(button(host, /^Note: Cap this at 1\?$/));
  assert.ok(button(host, /^Send 1 note to this chat$/));
});

test('a note is changed, removed or left as it was', async () => {
  const { host } = await open();
  await press(host, /^Added, line 2/);
  await write(host, 'First');
  await press(host, /^Save note$/);
  await press(host, /^Note: First$/);
  assert.equal((host.querySelector('input[placeholder="Note for the agent"]') as HTMLInputElement).value, 'First');
  await write(host, 'Second');
  await press(host, /^Cancel$/);
  assert.ok(button(host, /^Note: First$/), 'cancel keeps the old note');
  await press(host, /^Note: First$/);
  await write(host, 'Second');
  await press(host, /^Save note$/);
  assert.ok(button(host, /^Note: Second$/));
  assert.ok(button(host, /^Send 1 note to this chat$/));
  await press(host, /^Note: Second$/);
  await press(host, /^Remove note$/);
  assert.equal(button(host, /^Note:/), undefined);
  assert.equal(button(host, /^Send/), undefined, 'no notes, nothing to send');
  // a new note has nothing to remove
  await press(host, /^Added, line 2/);
  assert.equal(button(host, /^Remove note$/), undefined);
});

test('notes on several lines are sent as one message, and the person is taken back to the chat', async () => {
  const { host, sent, backs } = await open();
  await press(host, /^Removed, line 2/);
  await write(host, 'Why remove this?');
  await press(host, /^Save note$/);
  await press(host, /^Added, line 2/);
  await write(host, 'Cap this at 1?');
  await press(host, /^Save note$/);
  assert.ok(button(host, /^Send 2 notes to this chat$/));
  await press(host, /^Send 2 notes to this chat$/);
  assert.equal(sent.length, 1, 'one message, not one per note');
  assert.equal(sent[0][0], 'c');
  const back = parseUserText(sent[0][1]);
  assert.deepEqual(
    back.annotations.map((a: any) => [a.file.path, a.file.side, a.file.lines, a.annotation]),
    [
      ['src/a.ts', 'L', '2', 'Why remove this?'],
      ['src/a.ts', 'R', '2', 'Cap this at 1?'],
    ],
  );
  assert.match(back.annotations[1].text, /\+const a = 2;/);
  assert.equal(backs(), 1);
  assert.equal(button(host, /^Send/), undefined);
});

test('a refused send keeps the notes and says why; Discard drops them', async () => {
  let refuse = true;
  const { host, backs } = await open(
    diff,
    () => undefined,
    () => {
      if (refuse) throw new Error('Connect to a computer first');
      return 'id';
    },
  );
  await press(host, /^Added, line 2/);
  await write(host, 'Note');
  await press(host, /^Save note$/);
  await press(host, /^Send 1 note to this chat$/);
  assert.match(host.textContent!, /Connect to a computer first/);
  assert.equal(backs(), 0);
  assert.ok(button(host, /^Note: Note$/), 'the note is kept');
  assert.equal(button(host, /^Discard notes$/)!.textContent, 'Discard notes');
  await press(host, /^Discard notes$/);
  assert.ok(button(host, /^Note: Note$/), 'one tap only asks');
  await press(host, /^Tap again to discard$/);
  assert.equal(button(host, /^Send/), undefined);
  assert.doesNotMatch(host.textContent!, /Connect to a computer first/);
  refuse = false;
  // a failure that is not an Error is shown too
  const odd = await open(
    diff,
    () => undefined,
    () => {
      throw 'busy';
    },
  );
  await press(odd.host, /^Added, line 2/);
  await write(odd.host, 'Again');
  await press(odd.host, /^Save note$/);
  await press(odd.host, /^Send 1 note to this chat$/);
  assert.match(odd.host.textContent!, /busy/);
});

test('notes outlive the screen but not the chat they belong to', async () => {
  const first = await open();
  await press(first.host, /^Added, line 2/);
  await write(first.host, 'Keep me');
  await press(first.host, /^Save note$/);
  await act(async () => first.root.unmount());
  first.host.remove();
  mounted.splice(mounted.indexOf(mounted.find((m) => m.root === first.root)!), 1);
  // the same connection and chat: the note is still waiting
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  const mountAgain = (chatId: string) =>
    act(async () => root.render(createElement(Review, { runtime: first.runtime, chatId, back: () => {} })));
  await mountAgain('c');
  await flush();
  assert.ok(button(host, /^Send 1 note to this chat$/));
  await mountAgain('d');
  await flush();
  assert.equal(button(host, /^Send/), undefined, 'another chat has none');
  await mountAgain('c');
  await flush();
  assert.ok(button(host, /^Send 1 note to this chat$/));
});

test('a line without a known number takes no note, and a full set takes no new one', async () => {
  const bare = await open([
    { k: 'add', t: 'orphan' },
    { k: 'del', t: 'gone' },
    { k: 'ctx', t: 'same' },
  ]);
  assert.equal(button(bare.host, /^Added|^Line/), undefined, 'a plain row, not a button');
  assert.match(bare.host.textContent!, /orphan.*gone.*same/);
  const { host } = await open([{ k: 'hunk', t: '@@ -1,0 +1,30 @@' }, ...lines(notes.MOST_NOTES + 1)]);
  for (let i = 1; i <= notes.MOST_NOTES; i++) {
    await press(host, new RegExp(`^Added, line ${i}:`));
    await write(host, `n${i}`);
    await press(host, /^Save note$/);
  }
  assert.ok(button(host, new RegExp(`^Send ${notes.MOST_NOTES} notes to this chat$`)));
  await press(host, new RegExp(`^Added, line ${notes.MOST_NOTES + 1}:`));
  assert.match(host.textContent!, /Up to 20 notes at once/);
  assert.equal(button(host, /^Save note$/), undefined);
  await press(host, /^Cancel$/);
  // an old note can still be changed or removed
  await press(host, /^Note: n1$/);
  assert.ok(button(host, /^Save note$/));
  await press(host, /^Remove note$/);
  assert.ok(button(host, new RegExp(`^Send ${notes.MOST_NOTES - 1} notes to this chat$`)));
});

test('a quote is never cut in the middle of an emoji', () => {
  const t = notes.lineNote('a.ts', row('add', `${'x'.repeat(397)}😀tail`), 1, `${'y'.repeat(999)}😀z`);
  assert.doesNotMatch(t.hunk + t.text, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  assert.ok(t.hunk.endsWith('😀…'));
  assert.equal(Array.from(t.text).length, notes.NOTE_CHARS);
});

test('a note belongs to the line as it was shown: other text on the same number is another line', async () => {
  const rows = diff.map((r) => ({ ...r }));
  const { host } = await open(rows);
  await press(host, /^Added, line 2/);
  await write(host, 'Cap this');
  await press(host, /^Save note$/);
  await press(host, /^Back to changes$/);
  // the file changed on the computer: line 2 now says something else
  rows[3] = { k: 'add', t: 'const a = 3;' };
  await act(async () => button(host, /^View diff/)!.click());
  await flush();
  assert.equal(button(host, /^Note: Cap this$/), undefined, 'the old note is not drawn under new text');
  assert.ok(button(host, /^Send 1 note to this chat$/), 'but it is still there to be sent');
  await press(host, /^Added, line 2/);
  await write(host, 'And this');
  await press(host, /^Save note$/);
  assert.ok(button(host, /^Send 2 notes to this chat$/), 'the new line has its own note');
});

test('one note is written at a time, Send waits for it, and Start over closes it', async () => {
  const { host } = await open([{ k: 'hunk', t: '@@ -1,0 +1,4 @@' }, ...lines(4)], (m, p) => {
    if (m !== 'diff.read') return undefined;
    if (p.from > 0) throw new Error('page failed');
    return { binary: false, rows: [{ k: 'hunk', t: '@@ -1,0 +1,4 @@' }, ...lines(4)], next: 5, total: 9 };
  });
  await press(host, /^Added, line 1:/);
  await write(host, 'First');
  await press(host, /^Save note$/);
  assert.equal(button(host, /^Send 1 note to this chat$/)!.getAttribute('aria-disabled'), 'false');
  await press(host, /^Added, line 2:/);
  assert.equal(button(host, /^Send 1 note to this chat$/)!.getAttribute('aria-disabled'), 'true', 'a half-written note holds Send back');
  assert.match(host.textContent!, /Save or cancel the open note first/);
  await write(host, 'Draft that must not be lost');
  await press(host, /^Added, line 3:/);
  assert.equal(host.querySelectorAll('input[placeholder="Note for the agent"]').length, 1, 'a second tap opens no second field');
  assert.equal((host.querySelector('input[placeholder="Note for the agent"]') as HTMLInputElement).value, 'Draft that must not be lost');
  // the page after fails; starting over closes the field, whose line numbers may mean other lines now
  await press(host, /^Load more/);
  assert.match(host.textContent!, /page failed/);
  await press(host, /^Start over$/);
  assert.equal(host.querySelector('input[placeholder="Note for the agent"]'), null);
  assert.equal(button(host, /^Send 1 note to this chat$/)!.getAttribute('aria-disabled'), 'false');
});
