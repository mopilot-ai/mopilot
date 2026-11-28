// The ACP turn start in main (electron/harness/acpTurns.cjs): the prompt as content blocks, the
// events a window follows, the folder a new session starts in, and the title from the first words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { AcpTurns, acpBlocks } = require('../electron/harness/acpTurns.cjs');

const KEY = 'acp:kimi:k1';
const ref = { kind: 'acp:kimi', id: 'k1', instance: null, key: KEY };

function setup(o: { named?: boolean; fail?: string } = {}) {
  const events: [any, any][] = [];
  const sent: any[] = [];
  const renamed: any[] = [];
  const turns = new AcpTurns({
    send: async (chatId: string, key: string, payload: any, meta: any) => {
      if (o.fail) throw new Error(o.fail);
      sent.push({ chatId, key, payload, meta });
      return { turnId: `at-${meta.uuid}` };
    },
    rename: (key: string, name: string) => void renamed.push([key, name]),
    named: () => !!o.named,
    readImage: async (p: string) => (p === '/pic.png' ? 'data:image/png;base64,QUJD' : null),
    emit: (e: any, t?: any) => (events.push([e, t]), true),
    home: '/home/me',
  });
  return { turns, events, sent, renamed };
}

test('the prompt is the text, then images, then files as resource links', async () => {
  const blocks = await acpBlocks(
    'look',
    [
      { kind: 'skill', name: 'review', path: '/s' },
      { kind: 'selection', text: 'chosen' },
      { kind: 'image', path: '/pic.png', name: 'pic.png' },
      { kind: 'image', path: '/gone.png', name: 'gone.png' },
      { kind: 'file', path: '/a/b.txt', name: 'b.txt' },
    ],
    async (p: string) => (p === '/pic.png' ? 'data:image/png;base64,QUJD' : null),
  );
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /^\/review /);
  assert.match(blocks[0].text, /chosen/);
  assert.match(blocks[0].text, /look/);
  assert.deepEqual(blocks.slice(1), [
    { type: 'image', mimeType: 'image/png', data: 'QUJD' },
    { type: 'resource_link', uri: 'file:///a/b.txt', name: 'b.txt' },
  ]);
});

test('a file link is a well-formed file URL even when the path has spaces, # or %', async () => {
  const blocks = await acpBlocks('', [{ kind: 'file', path: '/my docs/report#1 50%.txt', name: 'report#1 50%.txt' }], async () => null);
  assert.deepEqual(blocks, [{ type: 'resource_link', uri: 'file:///my%20docs/report%231%2050%25.txt', name: 'report#1 50%.txt' }]);
  // the agent reads back exactly the attached file
  assert.equal(fileURLToPath(blocks[0].uri), '/my docs/report#1 50%.txt');
});

test('peer receipt uses the journal id, target folder and unattended permission metadata', async () => {
  const t = setup();
  t.turns.registerSession(KEY, { cwd: '/target-project' });
  const receipt = await t.turns.startTurn(
    'stable-chat',
    ref,
    { text: 'Peer request', opts: { human: false }, peer: { messageId: 'peer-id', sourceChatId: 'source' } },
    null,
  );
  assert.equal(t.sent[0].meta.uuid, 'peer-id');
  assert.equal(t.sent[0].meta.human, false);
  assert.equal(t.sent[0].payload.cwd, '/target-project');
  assert.deepEqual(receipt, { started: true, turnId: 'at-peer-id', itemId: 'u-peer-id' });
});

test('a turn starts with no window: events to the window it came from, the folder from the chat it created', async () => {
  const t = setup();
  t.turns.registerSession(KEY, { cwd: '/proj' });
  const r = await t.turns.startTurn(KEY, ref, { id: 'q5', text: 'hello there', attachments: [], opts: { human: true } }, 5);
  assert.equal(r.started, true);
  assert.equal(r.turnId, `at-${t.sent[0].meta.uuid}`);
  assert.equal(r.itemId, `u-${t.sent[0].meta.uuid}`);
  assert.equal(t.sent[0].key, KEY);
  assert.equal(t.sent[0].payload.cwd, '/proj');
  assert.deepEqual(t.sent[0].payload.blocks, [{ type: 'text', text: 'hello there' }]);
  assert.deepEqual(t.sent[0].payload.display, [{ type: 'text', text: 'hello there', text_elements: [] }]);
  assert.deepEqual(t.sent[0].meta.human, true);
  const [starting, started] = t.events;
  assert.equal(starting[0].kind, 'turnStarting');
  assert.equal(starting[0].itemId, 'q5', 'the send the window showed early');
  assert.equal(starting[1], 5);
  assert.equal(started[0].kind, 'turnStarted');
  assert.equal(started[0].clientId, starting[0].clientId);
  assert.equal(t.sent[0].meta.uuid, starting[0].clientId);
  // the folder only matters for a session that doesn't exist yet
  await t.turns.startTurn(KEY, ref, { text: 'more', attachments: [], opts: {} }, 5);
  assert.equal(t.sent[1].payload.cwd, '/home/me');
  assert.equal(t.sent[1].payload.config, undefined, 'a message with no model or effort sets none');
});

test("a scheduled run's model and effort go with its message, to be set on the session first", async () => {
  const t = setup();
  await t.turns.startTurn(KEY, ref, { text: 'run', attachments: [], opts: { model: 'opencode/glm-5.3-flash-free' } }, null);
  await t.turns.startTurn(KEY, ref, { text: 'run', attachments: [], opts: { effort: 'high' } }, null);
  assert.deepEqual(t.sent[0].payload.config, { model: 'opencode/glm-5.3-flash-free', effort: undefined });
  assert.deepEqual(t.sent[1].payload.config, { model: undefined, effort: 'high' });
  // what an earlier Auto turn left goes with the next message, to be set back on the session (acp/initialConfig.cjs)
  const restore = { model: { own: 'opencode/big-pickle', applied: 'opencode/glm-5.3-flash-free' } };
  await t.turns.startTurn(KEY, ref, { text: 'run', attachments: [], opts: { autoRestore: restore } }, null);
  assert.deepEqual(t.sent[2].payload.config, { model: undefined, effort: undefined, restore });
});

test("a handoff block goes in front of the text and the message is not the user's own", async () => {
  const t = setup();
  await t.turns.startTurn(KEY, ref, { text: 'go on', attachments: [], opts: { human: true, prefix: '<sage-handoff/>' } }, null);
  assert.equal(t.sent[0].payload.blocks[0].text, '<sage-handoff/>\n\ngo on');
  assert.equal(t.sent[0].meta.human, false);
  assert.equal(t.events[0][1], 'any');
});

test('the first message names the chat unless it has a name; a later segment is not named', async () => {
  const t = setup();
  await t.turns.startTurn(KEY, ref, { text: 'fix the build', attachments: [], opts: {} }, 1);
  assert.deepEqual(t.renamed, [[KEY, 'fix the build']]);
  assert.equal(t.events.at(-1)![0].kind, 'threadName');
  const u = setup({ named: true });
  await u.turns.startTurn(KEY, ref, { text: 'fix the build', attachments: [], opts: {} }, 1);
  assert.deepEqual(u.renamed, []);
  const v = setup();
  await v.turns.startTurn('other-chat', ref, { text: 'x', attachments: [], opts: {} }, 1);
  assert.deepEqual(v.renamed, []);
});

test('the name is read from the transcript without blocking; a turn started while it is read leaves naming to the first', async () => {
  const t = setup();
  let reads = 0;
  let release!: (named: boolean) => void;
  t.turns.named = () => (reads++, new Promise<boolean>((r) => (release = r)));
  const first = t.turns.startTurn(KEY, ref, { text: 'first', attachments: [], opts: {} }, 1);
  while (!reads) await new Promise((r) => setImmediate(r));
  assert.deepEqual((await t.turns.startTurn(KEY, ref, { text: 'second', attachments: [], opts: {} }, 1)).started, true);
  release(false);
  await first;
  assert.deepEqual(t.renamed, [[KEY, 'first']], 'named once, by the first message');
  assert.equal(reads, 1);
  // the next turn reads again
  t.turns.named = async () => true;
  await t.turns.startTurn(KEY, ref, { text: 'third', attachments: [], opts: {} }, 1);
  assert.deepEqual(t.renamed, [[KEY, 'first']]);
});

test("the agent's title replaces the first words, unless the user renamed the chat; the turn does not wait for it", async () => {
  // a transcript of title records as main keeps it, read by titleOf
  const titled = (o: { title: () => Promise<string | null>; userRenames?: boolean }) => {
    const t = setup();
    const records: { name: string; auto?: boolean }[] = [];
    const written: string[] = [];
    t.turns.rename = (key: string, name: string, auto?: boolean) => (t.renamed.push([key, name, !!auto]), records.push({ name, auto }));
    t.turns.titleOf = async () => records.at(-1) ?? null;
    t.turns.writeTitle = async (_key: string, text: string) => {
      written.push(text);
      if (o.userRenames) records.push({ name: 'Mine' });
      return o.title();
    };
    return { ...t, written };
  };
  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  // written: saved as an automatic title, and the window told what it replaces
  const t = titled({ title: async () => 'Build fix' });
  await t.turns.startTurn(KEY, ref, { text: 'fix the build', attachments: [], opts: {} }, 1);
  await flush();
  assert.deepEqual(t.written, ['fix the build']);
  assert.deepEqual(t.renamed, [
    [KEY, 'fix the build', true],
    [KEY, 'Build fix', true],
  ]);
  assert.deepEqual(t.events.at(-1)![0], { kind: 'threadName', key: KEY, chatId: KEY, name: 'Build fix', provisional: 'fix the build' });
  // renamed by the user while it was written: their name stays
  const u = titled({ title: async () => 'Build fix', userRenames: true });
  await u.turns.startTurn(KEY, ref, { text: 'fix the build', attachments: [], opts: {} }, 1);
  await flush();
  assert.deepEqual(u.renamed, [[KEY, 'fix the build', true]]);
  // no title (an agent that fails or answers nothing): the first words stay, saved once
  for (const title of [async () => null, async () => Promise.reject(new Error('no session'))]) {
    const v = titled({ title });
    await v.turns.startTurn(KEY, ref, { text: 'fix the build', attachments: [], opts: {} }, 1);
    await flush();
    assert.deepEqual(v.renamed, [[KEY, 'fix the build', true]]);
    assert.equal(v.events.filter(([e]) => e.kind === 'threadName').length, 1);
  }
  // a title still being written does not hold the turn's start
  const w = titled({ title: () => new Promise(() => {}) });
  const r = await w.turns.startTurn(KEY, ref, { text: 'fix the build', attachments: [], opts: {} }, 1);
  assert.equal(r.started, true);
  // a chat that already has a name asks for no title
  const x = titled({ title: async () => 'Build fix' });
  x.turns.named = async () => true;
  await x.turns.startTurn(KEY, ref, { text: 'fix the build', attachments: [], opts: {} }, 1);
  await flush();
  assert.deepEqual(x.written, []);
});

test('a turn that could not start says why, in the words the harness gave', async () => {
  const t = setup({ fail: "Error invoking remote method 'x': Error: Kimi Code can't take images" });
  const r = await t.turns.startTurn(KEY, ref, { text: 'hi', attachments: [], opts: {} }, 2);
  assert.deepEqual(r, { started: false, error: "Kimi Code can't take images" });
  assert.equal(t.events.at(-1)![0].kind, 'turnFailed');
  assert.equal(t.events.at(-1)![0].error, "Kimi Code can't take images");
});

test('a folder that is not absolute is not taken', () => {
  const t = setup();
  t.turns.registerSession(KEY, { cwd: 'relative' });
  assert.equal(t.turns.sessions.get(KEY).cwd, null);
});
