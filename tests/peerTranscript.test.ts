import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { readPeerTranscript, readPeerReference, readPeerTurns, peerHistoryReader } = require('../electron/session/peerTranscript.cjs');
const record = {
  segments: [
    { kind: 'codex', nativeId: 'c', count: 1 },
    { kind: 'claude', nativeId: 'cl', count: 1 },
    { kind: 'acp:test', nativeId: 'a', count: 1 },
    { kind: 'codex', nativeId: 'c', count: null },
  ],
};
test('reference and tool histories share segment ordering while reference output retains the recent end', async () => {
  const read = async (seg: any) => ({
    turns: [
      { id: `${seg.nativeId}-1`, items: [] },
      { id: `${seg.nativeId}-2`, items: [] },
    ],
  });
  const reference = await readPeerReference(record, read);
  const tool = await readPeerTranscript(record, {}, read);
  assert.deepEqual(
    reference.turns.map((t: any) => t.id),
    tool.records.map((r: any) => r.turn.id),
  );
  const single = { segments: [{ kind: 'codex', nativeId: 'c' }] };
  const huge = { id: 'large', items: [{ id: 'm', type: 'agentMessage', text: '文'.repeat(40000) + 'RECENT END' }] };
  const clipped = await readPeerReference(single, async () => ({ turns: [{ id: 'old', items: [] }, huge] }));
  assert.equal(clipped.earlierContentOmitted, true);
  assert.equal(clipped.turns[0].id, 'large');
  assert.ok(clipped.turns[0].items[0].text.includes('RECENT END'));
  assert.ok(Buffer.byteLength(JSON.stringify(clipped)) < 32768);
});
test('the whole history for a reader that summarizes it: no byte budget, the same segment order and omission', async () => {
  const single = { segments: [{ kind: 'codex', nativeId: 'c' }] };
  // a tool-heavy turn past the reference budget never hides the turns before it
  const huge = { id: 'large', items: [{ id: 'm', type: 'agentMessage', text: 'x'.repeat(40000) }] };
  const all = await readPeerTurns(single, async () => ({ turns: [{ id: 'old', items: [] }, huge] }));
  const reference = await readPeerReference(single, async () => ({ turns: [{ id: 'old', items: [] }, huge] }));
  assert.deepEqual(
    reference.turns.map((t: any) => t.id),
    ['large'],
  );
  assert.deepEqual(
    all.turns.map((t: any) => t.id),
    ['old', 'large'],
  );
  assert.equal(all.earlierContentOmitted, false);
  // a native page that was itself cut says so
  const cut = await readPeerTurns(single, async () => ({ turns: [huge], truncated: true }));
  assert.equal(cut.earlierContentOmitted, true);
  const read = async (seg: any) => ({ turns: [{ id: `${seg.nativeId}-1`, items: [] }] });
  // by chat id, as main wires it: the chat's record at the read, and a native reader made for each read
  let readers = 0;
  const records = new Map([['chat-1', record]]);
  const byId = peerHistoryReader({ records }, () => (readers++, read));
  assert.equal((await byId('chat-1')).turns.length, 3);
  await assert.rejects(byId('gone'), /chat_unavailable/);
  assert.equal(readers, 2);
  assert.deepEqual(
    (await readPeerTurns(record, read)).turns.map((t: any) => t.id),
    (await readPeerReference(record, read)).turns.map((t: any) => t.id),
  );
});

test('mixed and repeated segments read once and preserve stable chat chronology', async () => {
  const calls: string[] = [];
  const page = await readPeerTranscript(record, {}, async (seg: any) => {
    calls.push(seg.kind);
    return { turns: [{ id: `${seg.nativeId}-1` }, { id: `${seg.nativeId}-2` }] };
  });
  assert.deepEqual(calls, ['codex', 'claude', 'acp:test']);
  assert.deepEqual(
    page.records.map((r: any) => r.turn.id),
    ['c-1', 'cl-1', 'a-1', 'c-2'],
  );
});
test('bounded output advances past oversized turns and detects changed history', async () => {
  const single = { segments: [{ kind: 'codex', nativeId: 'c' }] };
  let turns = [
    { id: 'huge', text: '文'.repeat(50000) },
    { id: 'small', text: 'Hello'.repeat(35) },
  ];
  const read = async () => ({ turns });
  const page = await readPeerTranscript(single, { limitBytes: 256 }, read);
  assert.equal(page.records[0].turn.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(page.records)) <= 256);
  assert.ok(page.nextCursor);
  const next = await readPeerTranscript(single, { cursor: page.nextCursor, limitBytes: 256 }, read);
  assert.equal(next.records[0].turn.id, 'small');
  assert.equal(next.nextCursor, null);
  turns = [...turns, { id: 'new', text: 'New' }];
  await assert.rejects(readPeerTranscript(single, { cursor: page.nextCursor }, read), /transcript_changed/);
});
test('incomplete native history refuses ambiguous switched offsets and reports single history omission', async () => {
  const read = async () => ({ turns: [{ id: 'recent' }], truncated: true });
  await assert.rejects(readPeerTranscript(record, {}, read), /switched_history_too_large/);
  const single = { segments: [{ kind: 'acp:test', nativeId: 'a' }] };
  const page = await readPeerTranscript(single, {}, read);
  assert.equal(page.earlierContentOmitted, true);
  const signal = new AbortController();
  signal.abort();
  await assert.rejects(readPeerTranscript(single, { signal: signal.signal }, read), /aborted/);
  await assert.rejects(readPeerTranscript(single, { cursor: 'bad' }, read), /invalid_cursor/);
});
test('malformed cursors, missing chats, invalid adapter pages and id-less oversized turns fail or degrade explicitly', async () => {
  const single = { segments: [{ kind: 'codex', nativeId: 'c' }] };
  const read = async () => ({ turns: [{ text: '文'.repeat(50000) }] });
  for (const cursor of ['null', '{"offset":-1}', '{"offset":1.5}', '{"offset":9}']) {
    await assert.rejects(readPeerTranscript(single, { cursor }, read), /invalid_cursor/);
  }
  await assert.rejects(readPeerTranscript(null, {}, read), /chat_unavailable/);
  await assert.rejects(
    readPeerTranscript(single, {}, async () => ({ turns: null })),
    /invalid_transcript/,
  );
  const page = await readPeerTranscript(single, { limitBytes: Number.NaN }, read);
  assert.equal(page.limitBytes, 32768);
  assert.equal(page.records[0].turn.id, null);
  assert.equal(page.records[0].turn.truncated, true);
  const reference = await readPeerReference(single, read);
  assert.equal(reference.turns[0].id, '');
  assert.equal(reference.earlierContentOmitted, true);
  assert.deepEqual(await readPeerReference(single, async () => ({ turns: [] })), { turns: [], earlierContentOmitted: false });
});

test('cancellation during the last native read rejects instead of returning transcript data', async () => {
  const controller = new AbortController();
  const single = { segments: [{ kind: 'codex', nativeId: 'c' }] };
  await assert.rejects(
    readPeerTranscript(single, { signal: controller.signal }, async () => {
      controller.abort();
      return { turns: [{ id: 'late', items: [] }] };
    }),
    /aborted/,
  );
});

test('bounded tool and reference excerpts do not split surrogate pairs', async () => {
  const single = { segments: [{ kind: 'codex', nativeId: 'c' }] };
  const cutoff = Math.floor((256 - 3 - Buffer.byteLength(JSON.stringify({ turn: { id: null, excerpt: '', truncated: true } }))) / 6);
  const page = await readPeerTranscript(single, { limitBytes: 256 }, async () => ({
    turns: [{ text: 'x'.repeat(cutoff - 10) + '😀' + 'x'.repeat(1000) }],
  }));
  assert.ok(!/[\uD800-\uDBFF]$/.test(page.records[0].turn.excerpt), 'tool excerpt must not end with a lone high surrogate');
  const huge = { id: 't', text: 'y'.repeat(40000) + '😀' + 'x'.repeat(5375) };
  const reference = await readPeerReference(single, async () => ({ turns: [huge] }));
  const text = reference.turns[0].items[0].text.split('\n').slice(1).join('\n');
  assert.ok(!/^[\uDC00-\uDFFF]/.test(text), 'reference excerpt must not begin with a lone low surrogate');
  assert.ok(text.endsWith('x'.repeat(5375) + '"}'));
});

test('reference omission flags include clipping at the exact byte-budget boundary', async () => {
  const single = { segments: [{ kind: 'codex', nativeId: 'c' }] };
  for (const size of [32765, 32766, 32767, 32768]) {
    const turn = { id: 't', text: 'x'.repeat(size - Buffer.byteLength(JSON.stringify({ id: 't', text: '' }))) };
    assert.equal(Buffer.byteLength(JSON.stringify(turn)), size);
    const result = await readPeerReference(single, async () => ({ turns: [turn] }));
    assert.equal(result.earlierContentOmitted, size > 32765, `native turn of ${size} bytes`);
    if (size > 32765) assert.match(result.turns[0].items[0].text, /Native turn excerpt/);
    else assert.deepEqual(result.turns, [turn]);
  }
});

test('oversized turn identifiers cannot make a transcript page exceed its budget', async () => {
  const single = { segments: [{ kind: 'codex', nativeId: 'c' }] };
  for (const id of ['文'.repeat(200), '"'.repeat(200), 'x'.repeat(4000)]) {
    const page = await readPeerTranscript(single, { limitBytes: 256 }, async () => ({
      turns: [
        { id, text: 'body'.repeat(1000) },
        { id: 'next', text: 'x'.repeat(1000) },
      ],
    }));
    assert.ok(Buffer.byteLength(JSON.stringify(page.records)) <= 256, 'transcript records must stay within the requested byte budget');
    assert.equal(page.records[0].turn.id, null);
    assert.equal(page.records[0].turn.idOmitted, true);
    assert.equal(page.records[0].turn.truncated, true);
    assert.ok(page.nextCursor);
  }
});

test('identifiers that fit are preserved while excerpts adapt to their metadata size', async () => {
  const single = { segments: [{ kind: 'codex', nativeId: 'c' }] };
  const id = 'x'.repeat(180);
  const page = await readPeerTranscript(single, { limitBytes: 256 }, async () => ({ turns: [{ id, text: 'body'.repeat(1000) }] }));
  assert.equal(page.records[0].turn.id, id);
  assert.equal(page.records[0].turn.idOmitted, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(page.records)) <= 256);
});

test('reference excerpt identifiers retain complete Unicode characters', async () => {
  const single = { segments: [{ kind: 'codex', nativeId: 'c' }] };
  const id = 'x'.repeat(255) + '😀';
  const page = await readPeerReference(single, async () => ({ turns: [{ id, text: 'body'.repeat(10000) }] }));
  assert.equal(page.turns[0].id, 'x'.repeat(255));
  assert.equal(page.earlierContentOmitted, true);
});

test('missing adapter pages and malformed turns report invalid_transcript for tools and references', async () => {
  for (const kind of ['codex', 'claude', 'acp:test']) {
    const single = { segments: [{ kind, nativeId: 'native' }] };
    for (const page of [
      null,
      undefined,
      {},
      { turns: null },
      { turns: [null] },
      { turns: [undefined] },
      { turns: ['bad'] },
      { turns: [5] },
      { turns: [false] },
      { turns: [[]] },
      { turns: Array(1) },
    ]) {
      const read = async () => page;
      await assert.rejects(readPeerTranscript(single, {}, read), { code: 'invalid_transcript' });
      await assert.rejects(readPeerReference(single, read), { code: 'invalid_transcript' });
    }
  }
});

test('assistant-only history preserves final PR responses after large tool output across harness switches', async () => {
  const { responsePullRequest } = await import('../src/lib/responsePullRequest.ts');
  const url = 'https://github.com/org/repo/pull/42';
  const read = async (seg: any) => ({
    turns: [
      {
        id: `${seg.nativeId}-1`,
        status: 'completed',
        items: [
          { type: 'userMessage', content: 'Merged PR #99.' },
          { type: 'commandExecution', output: 'x'.repeat(40000) },
          { type: 'agentMessage', text: `Opened [PR #42](${url}).`, phase: null },
        ],
      },
      {
        id: `${seg.nativeId}-2`,
        status: 'completed',
        items: [
          null,
          { type: 'commandExecution', output: 'x'.repeat(40000) },
          { type: 'agentMessage', text: 'PR #42 is merged.', phase: 'final_answer' },
        ],
      },
      { id: `${seg.nativeId}-3`, status: 'inProgress', items: [{ type: 'agentMessage', text: 'PR #42 is not merged yet.' }] },
      { id: `${seg.nativeId}-4`, status: 'completed', items: null },
    ],
    truncated: false,
  });
  for (const kind of ['codex', 'claude', 'acp:test']) {
    const single = { segments: [{ kind, nativeId: 'native' }] };
    const result = await readPeerReference(single, read, true);
    assert.equal(result.earlierContentOmitted, false);
    assert.equal(result.turns.length, 3);
    assert.ok(result.turns.every((t: any) => t.items.every((item: any) => item.type === 'agentMessage')));
    assert.equal(responsePullRequest(result.turns)?.state, 'merged');
    assert.ok(JSON.stringify(result).length < 1000);
  }
  const switched = await readPeerReference(record, read, true);
  assert.equal(responsePullRequest(switched.turns)?.state, 'merged');
});

test('a reference read tells the native reader whether only assistant replies are wanted', async () => {
  const record = { segments: [{ kind: 'claude', nativeId: 'n', count: 1 }] } as any;
  const seen: unknown[] = [];
  const read = async (_seg: unknown, _signal: unknown, options: unknown) => (seen.push(options), { turns: [] });
  await readPeerReference(record, read, true);
  await readPeerReference(record, read);
  await readPeerTranscript(record, {}, read);
  assert.deepEqual(seen, [{ assistantOnly: true }, { assistantOnly: false }, { assistantOnly: false }]);
});
