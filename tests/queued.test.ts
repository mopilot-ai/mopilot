// How the queue tray labels a queued follow-up and hands it back to the composer (src/lib/queued.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queuedLabel, sideQueued, withQueued } from '../src/lib/queued.ts';

const q = (text: string, attachments: any[] = []) => ({ id: 'q', text, attachments, opts: {}, origin: null, queuedAt: 0 });

test('a row shows the message, else the names of its attachments', () => {
  assert.equal(queuedLabel(q('hello', [{ kind: 'file', path: '/a.txt', name: 'a.txt' }])), 'hello');
  assert.equal(
    queuedLabel(
      q('', [
        { kind: 'file', path: '/a.txt', name: 'a.txt' },
        { kind: 'image', path: '/dir/shot.png', name: '' },
      ]),
    ),
    'a.txt, shot.png',
  );
  assert.equal(queuedLabel(q('')), '');
});

test("a queued Continue in Chrome shows the user's short line, never the agent's hidden routing note", () => {
  const text =
    '<sage-browser-handoff>\nCall chrome_tabs_context_mcp, then navigate.\n</sage-browser-handoff>\nContinue in Chrome · task.test';
  assert.equal(queuedLabel(q(text)), 'Continue in Chrome · task.test');
  // Edit message puts back only what the user sees
  assert.equal(withQueued('', [], q(text)).text, 'Continue in Chrome · task.test');
  // a reply quote is the user's own text: it stays as it was
  const quoted = '<!-- reply 1 -->\n> earlier\nmy note';
  assert.equal(queuedLabel(q(quoted)), quoted);
  assert.equal(withQueued('', [], q(quoted)).text, quoted);
});

test('editing a queued message puts it ahead of the draft, keeping both sets of attachments', () => {
  const a = { kind: 'file' as const, path: '/a.txt', name: 'a.txt' };
  const b = { kind: 'file' as const, path: '/b.txt', name: 'b.txt' };
  assert.deepEqual(withQueued('', [], q('later', [a])), { text: 'later', attachments: [a] });
  assert.deepEqual(withQueued('  \n', [b], q('later', [a])), { text: 'later', attachments: [a, b] });
  assert.deepEqual(withQueued('draft', [b], q('later')), { text: 'later\ndraft', attachments: [b] });
});

// Claude Desktop 4.29.0 shows a message another session sent as "Received message from <session>", never its envelope
test('a queued message from another session reads as who sent it, with only its body to preview', () => {
  const sent = { kind: 'message' as const, chatId: 'b', from: 'a', body: 'merge now?', at: 1 };
  assert.deepEqual(sideQueued(sent, 'Mobile batch'), { label: 'Received message from Mobile batch', body: 'merge now?' });
  assert.deepEqual(sideQueued(sent, null), { label: 'Received message from another session', body: 'merge now?' });
  const long = { ...sent, body: 'x'.repeat(4000) };
  assert.equal(sideQueued(long, null).body, `${'x'.repeat(4000)}…`, 'a message cut by main says it goes on');
  assert.equal(sideQueued({ ...sent, body: 'x'.repeat(3999) }, null).body, 'x'.repeat(3999));
  const brief = { kind: 'brief' as const, chatId: 'b', from: 'a', title: 'Fix it', body: 'Do the thing', at: 1 };
  assert.deepEqual(sideQueued(brief, 'Parent'), { label: 'Task from Parent', body: 'Do the thing' });
  const wake = { kind: 'wake' as const, chatId: 'b', at: 1, notes: [{ childId: 'c', body: 'done' }] };
  assert.deepEqual(sideQueued(wake, null), { label: 'Report from 1 session', body: 'done' });
  const two = { ...wake, notes: [...wake.notes, { childId: 'd', body: 'failed' }] };
  assert.deepEqual(sideQueued(two, null), { label: 'Reports from 2 sessions', body: 'done\n\nfailed' });
});

test('the row shows the sender label instead of the envelope; an input no human wrote still wins over it', () => {
  const env = '<mopilot-side-session-message from="a">\nmerge now?\n</mopilot-side-session-message>';
  const side = { label: 'Received message from A', body: 'merge now?' };
  assert.equal(queuedLabel(q(env), null, side), 'Received message from A');
  assert.equal(queuedLabel(q(env), { by: 'momo', title: 'Digest', at: 0 }, side), 'MoMo: Digest');
});

test('only what the user wrote goes back to the composer', async () => {
  const { isUserQueued } = await import('../src/lib/queued.ts');
  assert.equal(isUserQueued(q('mine')), true);
  assert.equal(isUserQueued({ ...q('x'), sideSession: { id: 's' } }), false);
  assert.equal(isUserQueued({ ...q('x'), authored: { id: 'a' } }), false);
});
