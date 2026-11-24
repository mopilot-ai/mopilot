// electron/harness/claude/index.cjs composed from its section modules: fresh state per load, no module requiring the entry or
// forming a cycle, and the failures the sections swallow (a command list or settings broadcast that fails, a
// close that throws while a process is being replaced).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakes, load, fakeBin, flush, until, home, tmp, lastQuery } from './support/electron-claude.ts';

const bin = fakeBin('sections/claude');
const user = (text: string) => ({ role: 'user', content: text });
const of = (events: any[], key: string, kind: string) => events.filter((e: any) => e.key === key && e.kind === kind);
const claudeDir = new URL('../electron/harness/claude/', import.meta.url);

/** While it is installed, closing a session's input throws once (after closing it), ending the CLI as a closed input would. */
function throwingClose(Channel: any) {
  const close = Channel.prototype.close;
  let thrown = 0;
  Channel.prototype.close = function (this: any) {
    close.call(this);
    if (thrown++) return;
    lastQuery().end();
    throw new Error('close failed');
  };
  return {
    get thrown() {
      return thrown;
    },
    restore: () => (Channel.prototype.close = close),
  };
}

test('the entry composes its sections; none requires the entry or another section in a cycle', () => {
  // the Claude harness's own folder: the entry (index.cjs), its sections, and the adapter and per-turn modules beside them
  const sources = fs.readdirSync(claudeDir).filter((f) => /^[a-z][A-Za-z]*\.cjs$/.test(f));
  const graph = new Map<string, string[]>();
  for (const f of sources) {
    const text = fs.readFileSync(new URL(f, claudeDir), 'utf8');
    graph.set(
      f,
      [...text.matchAll(/require\('\.\/([a-z][A-Za-z]*\.cjs)'\)/g)].map((m) => m[1]),
    );
  }
  for (const [f, deps] of graph) if (f !== 'index.cjs') assert.ok(!deps.includes('index.cjs'), `${f} requires the entry`);
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (f: string, trail: string[]) => {
    assert.ok(!visiting.has(f), `require cycle: ${[...trail, f].join(' -> ')}`);
    if (done.has(f)) return;
    visiting.add(f);
    for (const d of graph.get(f) ?? []) visit(d, [...trail, f]);
    visiting.delete(f);
    done.add(f);
  };
  visit('index.cjs', []);
  for (const f of ['state.cjs', 'auth.cjs', 'cli.cjs', 'queries.cjs', 'catalog.cjs'])
    assert.ok(done.has(f), `${f} is composed by the entry`);
  for (const f of ['sessionOptions.cjs', 'sessions.cjs', 'chromeSessions.cjs', 'transcripts.cjs'])
    assert.ok(done.has(f), `${f} is composed by the entry`);
});

test('each load has its own state, and what main wires in later is what the sections read', async () => {
  const a = load();
  const b = load();
  assert.notEqual(a.claude.timing, b.claude.timing);
  fakes.onQuery = (q: any) => (q.reply = null);
  await a.claude.send('claude:own', { bin, sessionId: 'own', ephemeral: true }, user('hi'));
  assert.equal(a.claude.turnApi.isLive('claude:own'), true);
  assert.equal(b.claude.turnApi.isLive('claude:own'), false);
  // a provider set after the sections were made
  assert.equal(b.claude.authMode(), 'subscription');
  b.claude.setGatewayKeyProvider(() => 'mpk_1');
  await b.call('claude:setAuthMode', 'mopilot');
  assert.equal(b.claude.authMode(), 'mopilot');
  assert.equal(b.claude.billingSig(), 'mopilot:mpk_1');
  await a.call('claude:control', 'claude:own', 'close');
});

test('a CLI whose command list fails keeps the commands it had; settings that cannot reach the windows leave the session running', async () => {
  const t = load({ register: false });
  const handlers = new Map<string, (...a: any[]) => any>();
  const events: any[] = [];
  const catalogs: any[] = [];
  t.claude.register({ handle: (n: string, fn: (...a: any[]) => any) => handlers.set(n, fn) }, (ch: string, evt: any) => {
    if (ch === 'claude:catalog') catalogs.push(evt);
    if (ch !== 'claude:event') return;
    if (evt.kind === 'settings') throw new Error('window gone');
    events.push(evt);
  });
  const cwd = fs.mkdtempSync(path.join(tmp, 'sections-'));
  let listed = 0;
  fakes.onQuery = (q: any) => {
    q.supportedCommands = async () => {
      listed++;
      throw new Error('no commands');
    };
    q.reply = () => [{ type: 'system', subtype: 'init', skills: ['s'] }, { type: 'result' }];
  };
  const key = 'claude:sections';
  await t.claude.send(key, { bin, sessionId: 'sections', ephemeral: true, cwd }, user('hi'));
  await until('the result', () => of(events, key, 'message').some((e: any) => e.msg.type === 'result'));
  await until('the command list', () => listed === 1);
  await flush();
  assert.deepEqual(catalogs.at(-1).catalog, { commands: [], skills: ['s'], plugins: [], skillFiles: {}, terminalSlash: null, live: true });
  // the flags still apply when their settings can't be shown
  assert.equal(await handlers.get('claude:control')!({}, key, 'applyFlagSettings', { effortLevel: 'high', ultracode: true }), true);
  await flush();
  assert.deepEqual(
    lastQuery().calls.find((c: any[]) => c[0] === 'applyFlagSettings'),
    ['applyFlagSettings', { effortLevel: 'high', ultracode: true }],
  );
  assert.equal(t.claude.turnApi.isLive(key), true);
  await handlers.get('claude:control')!({}, key, 'close');
});

test('a close that throws while idle CLIs restart on new credentials is ignored', async () => {
  const t = load();
  fakes.run = () => ({ stdout: '' });
  const key = 'claude:restart';
  await t.claude.send(key, { bin, sessionId: 'restart' }, user('hi'));
  await until('the reply', () => !t.claude.ownBusy(key));
  const close = throwingClose(t.claude.Channel);
  try {
    await t.call('claude:setApiKey', 'sk-ant-1');
    await flush();
    assert.equal(close.thrown, 1);
  } finally {
    close.restore();
  }
  // the CLI still ended, and its end is the chat's (nothing replaces it)
  await until('the process ended', () => !t.claude.turnApi.isLive(key));
  assert.equal(of(t.events, key, 'closed').length, 1);
});

test('a close that throws while a send moves the chat to another login still starts the new process', async () => {
  const t = load();
  fakes.run = () => ({ stdout: '' });
  const key = 'claude:moved';
  await t.claude.send(key, { bin, sessionId: 'moved' }, user('one'));
  await until('the first reply', () => !t.claude.ownBusy(key));
  const first = lastQuery();
  const close = throwingClose(t.claude.Channel);
  try {
    await t.claude.send(key, { bin, sessionId: 'moved', account: 'other' }, user('two'));
    assert.equal(close.thrown, 1);
  } finally {
    close.restore();
  }
  assert.notEqual(lastQuery(), first);
  assert.ok(first.closed);
  await t.call('claude:control', key, 'close');
});

test('a close that throws after a rewind still ends the process, so the next message resumes before the edit', async () => {
  const t = load();
  fakes.run = () => ({ stdout: '' });
  const sid = '55555555-5555-4555-8555-555555555555';
  const key = `claude:${sid}`;
  const projects = path.join(home, '.claude', 'projects', 'sections');
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(
    path.join(projects, `${sid}.jsonl`),
    [
      { type: 'user', uuid: 'm1', parentUuid: null },
      { type: 'file-history-snapshot', messageId: 'm1' },
      { type: 'user', uuid: 'm2', parentUuid: 'a1' },
      { type: 'file-history-snapshot', messageId: 'm2' },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  );
  fakes.onQuery = () => {};
  await t.call('claude:rewind', key, { bin, sessionId: sid }, 'm2', true);
  const close = throwingClose(t.claude.Channel);
  try {
    assert.deepEqual(await t.call('claude:rewind', key, { bin, sessionId: sid }, 'm2', false), {
      canRewind: true,
      filesChanged: ['f'],
    });
    assert.equal(close.thrown, 1);
  } finally {
    close.restore();
  }
  assert.equal(t.claude.turnApi.isLive(key), false);
  await t.claude.send(key, { bin, sessionId: sid, resume: true }, user('again'));
  assert.equal(lastQuery().options.resumeSessionAt, 'a1');
  await t.call('claude:control', key, 'close');
});
