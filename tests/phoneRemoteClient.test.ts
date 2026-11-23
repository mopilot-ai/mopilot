// The phone's M3 client: owner scoping, defensive reads of the Mac's menus, start ids, chunk streams for files and recordings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../tests/support/phone/register.ts';
// loaded after the native-module aliases are registered
const clientPath = '../mobile/src/remote/client.ts';
const uploadPath = '../mobile/src/remote/upload.ts';
const client = await import(clientPath);
const { CHUNK, Cancelled, chunksFor, upload, sendChunks } = await import(uploadPath);

const runtimeOf = (handler: (method: string, params: any) => unknown, snap: any = { selectedPair: 'p', generation: 1 }) => {
  const calls: [string, any][] = [];
  const state = { snap };
  const runtime: any = {
    snapshot: () => state.snap,
    request: async (method: string, params: any) => {
      calls.push([method, params]);
      return handler(method, params);
    },
  };
  return { runtime, calls, state };
};
const rejects = (p: Promise<unknown>, expected: RegExp | ((e: Error) => boolean) | (new () => Error)) =>
  assert.rejects(p, expected as never);

test('a request answered after the computer changed is dropped, and one started after is refused', async () => {
  const { runtime, state } = runtimeOf(async () => {
    state.snap = { selectedPair: 'q', generation: 1 };
    return { ok: true };
  });
  const request = client.ownedRequest(runtime);
  await rejects(request('x'), /computer changed/);
  await rejects(request('y'), /computer changed/);
});

test('generation changes also retire a request, and offline errors read plainly', async () => {
  const gen = runtimeOf(async () => {
    gen.state.snap = { selectedPair: 'p', generation: 2 };
    return {};
  });
  await rejects(client.ownedRequest(gen.runtime)('x'), /computer changed/);
  const off = runtimeOf(async () => {
    throw new Error('Computer is offline');
  });
  await rejects(client.ownedRequest(off.runtime)('x'), /offline or asleep/);
  // the original message stays as the cause, for a screen that must tell a request cut off in flight from one that never left
  const cut = runtimeOf(async () => {
    throw new Error('relay disconnected');
  });
  await assert.rejects(
    client.ownedRequest(cut.runtime)('x'),
    (e: any) => /offline or asleep/.test(e.message) && e.cause.message === 'relay disconnected',
  );
  const other = runtimeOf(async () => {
    throw 'boom';
  });
  await rejects(client.ownedRequest(other.runtime)('x'), /boom/);
  assert.equal(client.explain(new Error('Relay disconnected')), 'Your computer is offline or asleep. Wake it and try again.');
});

test('capabilities read methods and ceiling, with safe defaults', async () => {
  const full = runtimeOf(() => ({ capabilities: { methods: ['diff.list', 7], permissionCeiling: 'default' } }));
  const caps = await client.capabilities(client.ownedRequest(full.runtime));
  assert.deepEqual([...caps.methods!], ['diff.list']);
  assert.equal(caps.ceiling, 'default');
  assert.equal(caps.mirrors, null);
  for (const [value, expected] of [
    [true, true],
    [false, false],
    ['yes', null],
  ])
    assert.equal(
      (await client.capabilities(client.ownedRequest(runtimeOf(() => ({ capabilities: { mirrors: value } })).runtime))).mirrors,
      expected,
    );
  const none = runtimeOf(() => ({}));
  assert.deepEqual(await client.capabilities(client.ownedRequest(none.runtime)), {
    methods: null,
    ceiling: 'auto-review',
    mirrors: null,
    renameChats: false,
    archiveChats: false,
    sideChats: false,
  });
  assert.doesNotThrow(() => client.needs(null, 'diff.list', 'x'));
  assert.doesNotThrow(() => client.needs({ methods: null, ceiling: 'a' }, 'diff.list', 'x'));
  assert.doesNotThrow(() => client.needs({ methods: new Set(['diff.list']), ceiling: 'a' }, 'diff.list', 'x'));
  assert.throws(() => client.needs({ methods: new Set(), ceiling: 'a' }, 'diff.list', 'review'), client.Unavailable);
});

test('start menus keep only well-formed harnesses and projects', async () => {
  const { runtime } = runtimeOf((m) =>
    m === 'machine.hello'
      ? { capabilities: { methods: [] } }
      : m === 'harnesses.list'
        ? { harnesses: [{ id: 'claude', label: 'Claude Code' }, { id: 'codex' }, { label: 'no id' }, null] }
        : { projects: [{ id: 'a', name: 'App' }, { id: 'b', label: 'Beta' }, { id: 'c' }, 'x'] },
  );
  const out = await client.loadStart(client.ownedRequest(runtime));
  assert.deepEqual(out.harnesses, [
    { id: 'claude', label: 'Claude Code' },
    { id: 'codex', label: 'codex' },
  ]);
  assert.deepEqual(out.projects, [
    { id: 'a', label: 'App' },
    { id: 'b', label: 'Beta' },
    { id: 'c', label: 'c' },
  ]);
  const empty = runtimeOf(() => ({}));
  const none = await client.loadStart(client.ownedRequest(empty.runtime));
  assert.deepEqual([none.harnesses, none.projects], [[], []]);
});

test('options hide full access and anything above the ceiling, and keep only a current permission that is offered', async () => {
  const options = {
    models: [
      { id: 'm1', label: 'M1', efforts: [{ id: 'low', label: 'Low' }, { label: 'x' }, { id: 'hi' }], defaultEffort: 'low' },
      { id: 'm2' },
      { label: 'no id' },
    ],
    accounts: [{ id: 'work', label: 'Work' }, { id: 'old', loggedIn: false }, { label: 'x' }, { id: 'bare' }],
    model: 'm1',
    effort: 'low',
    permission: {
      value: 'default',
      rows: [
        { id: 'read-only', label: 'Read only', detail: 'd' },
        { id: 'default', label: 'Ask', detail: 'e', disabled: 'Not for this model' },
        { id: 'auto-review', label: 'Auto' },
        { id: 'full-access', label: 'Bypass' },
        { id: 'plan', label: 'Plan' },
        { label: 'no id' },
      ],
    },
  };
  const { runtime, calls } = runtimeOf(() => options);
  const out = await client.loadOptions(client.ownedRequest(runtime), 'claude', 'default');
  assert.deepEqual(calls[0], ['options.get', { harness: 'claude' }]);
  assert.deepEqual(
    out.permissions.map((p) => p.id),
    ['read-only', 'default'],
  );
  assert.equal(out.permissions[1].disabled, 'Not for this model');
  assert.equal(out.permission, 'default');
  assert.deepEqual(
    out.models.map((m) => [m.id, m.label, m.efforts.map((e) => e.id), m.defaultEffort]),
    [
      ['m1', 'M1', ['low', 'hi'], 'low'],
      ['m2', 'm2', [], null],
    ],
  );
  assert.equal(out.model, 'm1');
  assert.deepEqual(out.accounts, [
    { id: 'work', label: 'Work' },
    { id: 'old', label: 'old', signedOut: true },
    { id: 'bare', label: 'bare' },
  ]);
  const capped = await client.loadOptions(
    client.ownedRequest(runtimeOf(() => ({ ...options, permission: { ...options.permission, value: 'auto-review' } })).runtime),
    'claude',
    'default',
  );
  assert.equal(capped.permission, null);
  const loose = await client.loadOptions(
    client.ownedRequest(runtimeOf(() => ({ permission: { rows: [{ id: 'default' }, { id: 'read-only', disabled: 'no' }] } })).runtime),
    'claude',
    'auto-review',
  );
  assert.deepEqual(loose.permissions, [
    { id: 'default', label: 'default', detail: '' },
    { id: 'read-only', label: 'read-only', detail: '', disabled: 'no' },
  ]);
  const bare = await client.loadOptions(client.ownedRequest(runtimeOf(() => ({ models: 3 })).runtime), 'codex', 'default');
  assert.deepEqual(bare, {
    models: [],
    accounts: [],
    model: null,
    effort: null,
    permissions: [],
    permission: null,
    permissionLabel: null,
    macOnly: [],
  });
  await rejects(client.loadOptions(client.ownedRequest(runtimeOf(() => 'text').runtime), 'codex', 'default'), /Could not read the options/);
});

test('starting a chat sends only what was picked and returns the new chat id', async () => {
  const { runtime, calls } = runtimeOf(() => ({ chatId: 'new' }));
  const request = client.ownedRequest(runtime);
  const full = {
    harness: 'claude',
    text: 'hi',
    projectId: 'p1',
    model: 'm',
    effort: 'low',
    permission: 'default',
    account: 'work',
    worktree: true,
    startId: 'start-0001',
    attachments: ['0123456789abcdef'],
  };
  assert.deepEqual(await client.startChat(request, full), { chatId: 'new', warning: null });
  assert.equal(calls[0][0], 'chat.start');
  assert.deepEqual({ ...calls[0][1], deadline: undefined }, { ...full, deadline: undefined });
  await client.startChat(request, {
    harness: 'codex',
    text: 'x',
    projectId: null,
    model: null,
    effort: null,
    permission: null,
    account: null,
    worktree: false,
    startId: 'start-0002',
    attachments: [],
  });
  assert.deepEqual(Object.keys(calls[1][1]).sort(), ['attachments', 'deadline', 'harness', 'startId', 'text']);
  // a worktree needs a project: without one the flag is not sent
  await client.startChat(request, { ...full, projectId: null });
  assert.equal('worktree' in calls[2][1], false);
  await rejects(client.startChat(client.ownedRequest(runtimeOf(() => ({})).runtime), full), /Could not read the new chat/);
  // on a Host: its id and folder go, this Mac's project, account and worktree do not; a held start says why
  const held = runtimeOf(() => ({ chatId: 'h', warning: 'Your message didn’t start: Build box is offline.' }));
  const r = await client.startChat(client.ownedRequest(held.runtime), { ...full, hostId: 'h1', folder: '/code/app' });
  assert.deepEqual(r, { chatId: 'h', warning: 'Your message didn’t start: Build box is offline.' });
  const keyed = runtimeOf(() => ({ chatId: 'k' }));
  await client.startChat(client.ownedRequest(keyed.runtime), { ...full, hostId: 'h1', folder: '/code/app', credential: { source: 'key' } });
  assert.deepEqual(keyed.calls[0][1].credential, { source: 'key' });
  // a chat on this Mac has no such choice: it is not sent
  await client.startChat(client.ownedRequest(keyed.runtime), { ...full, credential: { source: 'key' } });
  assert.equal('credential' in keyed.calls[1][1], false);
  const sent = held.calls[0][1];
  assert.deepEqual(
    [sent.hostId, sent.folder, sent.projectId, sent.account, sent.worktree],
    ['h1', '/code/app', undefined, undefined, undefined],
  );
  // 'local' is this Mac: sent as a plain start
  await client.startChat(request, { ...full, hostId: 'local', folder: '/x' });
  assert.deepEqual([calls.at(-1)![1].hostId, calls.at(-1)![1].projectId], [undefined, 'p1']);
});

const chunkReply = (p: any) => ({
  stream: p.stream,
  received: p.index + 1,
  done: p.index + 1 === p.total,
  ...(p.index + 1 === p.total && p.purpose === 'file' ? { id: '0123456789abcdef' } : {}),
});
const picked = (chars: number, name = 'p.jpg') => ({ name, mime: 'image/jpeg', base64: 'A'.repeat(chars) });

test('a file goes as an ordered chunk stream of aligned parts with progress, and returns the attachment', async () => {
  const seen: [number, number][] = [];
  const { runtime, calls } = runtimeOf((_m, p) => chunkReply(p));
  const request = client.ownedRequest(runtime);
  const signal = new AbortController().signal;
  assert.deepEqual(await upload(request, picked(10), (s: number, t: number) => seen.push([s, t]), signal), {
    id: '0123456789abcdef',
    name: 'p.jpg',
  });
  assert.deepEqual(seen, [
    [0, 1],
    [1, 1],
  ]);
  assert.equal(calls[0][0], 'chat.attach');
  assert.deepEqual(
    { ...calls[0][1], stream: undefined },
    { stream: undefined, index: 0, total: 1, data: 'AAAAAAAAAA', name: 'p.jpg', mime: 'image/jpeg', purpose: 'file' },
  );
  calls.length = 0;
  const big = picked(CHUNK * 2 + 4);
  assert.equal(chunksFor(big.base64), 3);
  await upload(request, big, () => {}, signal);
  assert.deepEqual(
    calls.map((c) => c[1].index),
    [0, 1, 2],
  );
  assert.equal(new Set(calls.map((c) => c[1].stream)).size, 1);
  assert.match(calls[0][1].stream, /^[\w-]{8,64}$/);
  assert.ok(calls.every((c) => c[1].total === 3 && c[1].data.length <= CHUNK && c[1].data.length % 4 === 0));
  assert.equal(calls.map((c) => c[1].data).join(''), big.base64);
});

test('each upload gets its own stream id', async () => {
  const { runtime, calls } = runtimeOf((_m, p) => chunkReply(p));
  const request = client.ownedRequest(runtime);
  await upload(request, picked(8), () => {}, new AbortController().signal);
  await upload(request, picked(8), () => {}, new AbortController().signal);
  assert.notEqual(calls[0][1].stream, calls[1][1].stream);
});

test('uploads refuse over the Mac’s limit, stop on cancel, and need a confirmed attachment', async () => {
  const { runtime, calls } = runtimeOf((_m, p) => chunkReply(p));
  const request = client.ownedRequest(runtime);
  await rejects(
    upload(request, picked(28_000_000), () => {}, new AbortController().signal),
    /larger than 20 MB/,
  );
  await rejects(
    sendChunks(request, picked(36_000_000), 'audio', () => {}, new AbortController().signal),
    /recording is too long/,
  );
  const controller = new AbortController();
  await rejects(
    upload(request, picked(CHUNK * 2), (s: number) => s === 1 && controller.abort(), controller.signal),
    (e: Error) => e instanceof Cancelled && /cancelled/.test(e.message),
  );
  assert.equal(calls.length, 1);
  const late = new AbortController();
  late.abort();
  await rejects(
    upload(request, picked(5), () => {}, late.signal),
    Cancelled,
  );
  const last = new AbortController();
  await rejects(
    upload(request, picked(5), (s: number) => s === 1 && last.abort(), last.signal),
    Cancelled,
  );
  for (const reply of [{ done: false }, null, { done: true }, { done: true, id: 3 }])
    await rejects(
      upload(client.ownedRequest(runtimeOf(() => reply).runtime), picked(5), () => {}, new AbortController().signal),
      /did not confirm/,
    );
});

test('a recording is sent as audio chunks, then transcribed by stream; the text is trimmed and an empty one refused', async () => {
  const handler = (text: unknown) => (m: string, p: any) => (m === 'chat.attach' ? chunkReply(p) : text);
  const a = runtimeOf(handler({ text: '  hello ', saveError: 'disk' }));
  const clip = { base64: 'A'.repeat(CHUNK + 4), mime: 'audio/wav' as const };
  assert.deepEqual(await client.transcribe(client.ownedRequest(a.runtime), clip, null, new AbortController().signal), {
    text: 'hello',
    saveError: 'disk',
  });
  const attach = a.calls.filter((c) => c[0] === 'chat.attach');
  assert.deepEqual(
    attach.map((c) => [c[1].purpose, c[1].mime, c[1].index]),
    [
      ['audio', 'audio/wav', 0],
      ['audio', 'audio/wav', 1],
    ],
  );
  assert.deepEqual(a.calls.at(-1), ['chat.transcribe', { stream: attach[0][1].stream, mime: 'audio/wav' }]);
  const signal = new AbortController().signal;
  const plain = runtimeOf(handler({ text: 'x' }));
  assert.deepEqual(await client.transcribe(client.ownedRequest(plain.runtime), clip, null, signal), { text: 'x', saveError: null });
  await rejects(
    client.transcribe(client.ownedRequest(runtimeOf(handler({ text: ' ' })).runtime), clip, null, signal),
    /No speech was heard/,
  );
  await rejects(
    client.transcribe(client.ownedRequest(runtimeOf(handler({})).runtime), clip, null, signal),
    /Could not read the transcript/,
  );
  await rejects(client.transcribe(client.ownedRequest(plain.runtime), clip, { methods: new Set(), ceiling: 'x' }, signal), /dictate/);
});

test('only the runtime’s own transport errors read as offline', () => {
  assert.equal(client.explain(new Error('Computer is offline')), 'Your computer is offline or asleep. Wake it and try again.');
  assert.equal(client.explain(new Error("Can't open offline-notes.md")), "Can't open offline-notes.md");
  // the relay client's own message is lowercase
  assert.equal(client.explain(new Error('relay disconnected')), 'Your computer is offline or asleep. Wake it and try again.');
});

test('start menus still load when the Mac does not answer machine.hello', async () => {
  const { runtime } = runtimeOf((m) => {
    if (m === 'machine.hello') throw new Error('no hello');
    return m === 'harnesses.list' ? { harnesses: [{ id: 'claude' }] } : { projects: [] };
  });
  const out = await client.loadStart(client.ownedRequest(runtime));
  assert.deepEqual(out.caps, { methods: null, ceiling: 'auto-review' });
  assert.equal(out.harnesses.length, 1);
});

test('a retry carries on from the part the Mac confirmed, and starts over under a new stream when the Mac forgot it', async () => {
  let failAt = 1;
  let forgotten = false;
  const { runtime, calls } = runtimeOf((_m, p) => {
    if (p.index === failAt) {
      failAt = -1;
      throw new Error('Computer is offline');
    }
    if (forgotten && p.index > 0 && calls.length > 0 && p.stream === firstStream) throw new Error('Send that upload again from the start.');
    return chunkReply(p);
  });
  const request = client.ownedRequest(runtime);
  const file = picked(CHUNK * 2 + 4);
  const resume = { stream: null as string | null, next: 0 };
  await rejects(
    sendChunks(request, file, 'file', () => {}, new AbortController().signal, resume),
    /offline or asleep/,
  );
  const firstStream = resume.stream;
  assert.equal(resume.next, 1);
  calls.length = 0;
  const done = await sendChunks(request, file, 'file', () => {}, new AbortController().signal, resume);
  assert.deepEqual(
    calls.map((c) => [c[1].stream === firstStream, c[1].index]),
    [
      [true, 1],
      [true, 2],
    ],
  );
  assert.equal(done.stream, firstStream);
  // the Mac no longer holds the stream: the file is sent again from part 0 under a new id
  forgotten = true;
  const again = { stream: firstStream, next: 1 };
  calls.length = 0;
  const restarted = await sendChunks(request, file, 'file', () => {}, new AbortController().signal, again);
  assert.deepEqual(
    calls.map((c) => c[1].index),
    [1, 0, 1, 2],
  );
  assert.notEqual(restarted.stream, firstStream);
  // cancelling is never retried
  const stop = new AbortController();
  const cancelled = { stream: firstStream, next: 1 };
  stop.abort();
  await rejects(
    sendChunks(request, file, 'file', () => {}, stop.signal, cancelled),
    Cancelled,
  );
});
