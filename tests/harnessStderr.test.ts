// Process diagnostic tails: bounded live storage and process-owned error reports for every harness family.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire, registerHooks } from 'node:module';
import { test } from 'node:test';
import { winbinStub } from './support/winbin-stub.ts';

const require = createRequire(import.meta.url);
const root = new URL('../', import.meta.url);
const stubs = new Map<string, any>();
const stub = (path: string, value: any) => stubs.set(new URL(path, root).href, value);
(globalThis as any).__stderrStubs = stubs;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL) {
      const url = new URL(specifier, context.parentURL).href;
      if (stubs.has(url)) return { url, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (stubs.has(url))
      return { format: 'commonjs', source: `module.exports = globalThis.__stderrStubs.get(${JSON.stringify(url)});`, shortCircuit: true };
    return next(url, context);
  },
});
stub('electron/platform/winbin.cjs', winbinStub());
stub('electron/capabilities/contract/serverRequests.cjs', { InterceptChain: class {} });
stub('electron/harness/acp/rpc.cjs', {
  RpcPeer: class {
    close() {}
    finishInput(done: () => void) {
      done();
    }
  },
});
stub('electron/session/contract/inputGuard.cjs', {});
stub('electron/harness/claude/tasks.cjs', { emptyTasks: () => new Map(), settleAll: () => false });
stub('electron/harness/claude/liveOutput.cjs', { createLiveOutput: () => null });
stub('electron/harness/claude/chromeTabs.cjs', {});
stub('electron/harness/claude/chromeLink.cjs', {});
stub('electron/capabilities/mcp/sdkMcp.cjs', {});
stub('electron/harness/claude/sessionTools.cjs', { prepareSessionTools: async () => {} });
stub('electron/harness/claude/transcripts.cjs', {});
stub('electron/harness/claude/sessionOptions.cjs', {
  Channel: class {},
  wantsReadOnly: () => false,
  restoreMode: () => 'default',
  buildSessionOptions: (_opts: any, extra: any) => extra,
});
const { AppServer } = require('../electron/harness/codexProcess.cjs');
const { AcpAgent } = require('../electron/harness/acp/agent.cjs');
const { createSessions } = require('../electron/harness/claude/sessions.cjs');
const held = (tail: any): string => (Array.isArray(tail) ? tail.join('') : tail.text);
const block = 'diagnostic '.repeat(8192);

function child() {
  const p: any = new EventEmitter();
  p.pid = 42;
  p.stdin = Object.assign(new EventEmitter(), { write() {} });
  p.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  p.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  return p;
}
function codex() {
  const children: any[] = [];
  const reports: any[] = [];
  const s = new AppServer({
    spawn: () => {
      const p = child();
      children.push(p);
      return p;
    },
  });
  s.listeners.add((e: any) => reports.push(e));
  return { s, children, reports };
}
function acp() {
  const p = child();
  const a = new AcpAgent({ harness: 'test-acp', command: 'fake', env: {}, cwd: '/', spawnFn: () => p, onRequest() {} });
  a.start();
  return { a, p };
}
async function claude(key = 'chat') {
  let reject!: (reason: Error | string) => void;
  const pending = new Promise((_resolve, fail) => {
    reject = fail;
  });
  const query = {
    async *[Symbol.asyncIterator]() {
      await pending;
    },
  };
  let options: any;
  const reports: any[] = [];
  const state: any = {
    sdk: async () => ({
      query: (o: any) => {
        options = o.options;
        return query;
      },
    }),
    activeAccount: () => 'login',
    sessions: new Map(),
    resumeAt: new Map(),
    prewarmed: new Set(),
    onProcess() {},
    emit: (e: any) => reports.push(e),
  };
  const sessions = createSessions(state, {
    cli: { findBinary: async () => 'fake' },
    auth: {
      billingSig: () => 'subscription',
      sessionStale: () => false,
      configIdOf: () => 'login',
      nativeChromeFor: () => false,
      sessionEnv: () => ({}),
    },
    catalog: {},
    chrome: {},
  });
  const s = await sessions.startSession(key, { ephemeral: true, chatId: key });
  return {
    s,
    options,
    reports,
    fail: async (reason: Error | string = new Error('crashed')) => {
      reject(reason);
      await s.done;
    },
  };
}

test('Codex retains only its report budget while large stderr chunks arrive', () => {
  const t = codex();
  t.s.start();
  for (let i = 0; i < 201; i++) t.children[0].stderr.emit('data', block);
  assert.ok(held(t.s.stderrTail).length <= 4000, `retained ${held(t.s.stderrTail).length} units`);
  t.children[0].stderr.emit('data', 'latest');
  t.children[0].emit('exit', 1, null);
  assert.equal(t.reports.at(-1).stderr, (block + 'latest').slice(-4000));
});

test('ACP retains only its report budget and reports the newest stderr on failure', () => {
  const { a, p } = acp();
  for (let i = 0; i < 51; i++) p.stderr.emit('data', block);
  assert.ok(held(a.stderr).length <= 2000, `retained ${held(a.stderr).length} units`);
  p.stderr.emit('data', 'latest');
  p.emit('error', new Error('failed'));
  assert.equal(a.exited.stderr, (block + 'latest').slice(-2000));
});

test('Claude retains only its report budget and reports it without an open window', async () => {
  const t = await claude();
  for (let i = 0; i < 101; i++) t.options.stderr(block);
  const text = held(t.s.stderr);
  await t.fail();
  assert.ok(text.length <= 2000, `retained ${text.length} units`);
  assert.equal(t.reports.find((e: any) => e.kind === 'error').stderr, block.slice(-2000));
});

test('Codex restart starts empty and late stderr/exit from the old process cannot pollute it', () => {
  const t = codex();
  t.s.start();
  const old = t.children[0];
  old.stderr.emit('data', 'old failure');
  t.s.stop();
  t.s.start();
  assert.equal(held(t.s.stderrTail), '');
  const current = t.children[1];
  current.stderr.emit('data', 'current');
  old.stderr.emit('data', ' late old failure');
  old.emit('exit', 1, null);
  current.emit('exit', 1, null);
  assert.equal(t.reports.at(-1).stderr, 'current');
});

test('the shared tail retains tiny chunks, copies only the bounded suffix and preserves Unicode boundaries', () => {
  const { StderrTail } = require('../electron/harness/stderrTail.cjs');
  const tail = new StderrTail(4);
  tail.push('');
  assert.equal(tail.text, '');
  for (const text of ['a', 'b', 'c', 'd', 'e']) tail.push(text);
  assert.equal(tail.text, 'bcde');
  tail.push('');
  assert.equal(tail.text, 'bcde');
  tail.push('x😀ab');
  assert.equal(tail.text, '😀ab');
  tail.push('c');
  assert.equal(tail.text, 'abc');
  tail.push(Buffer.from('z'));
  assert.equal(tail.text, 'abcz');
});

test('independent ACP and Claude processes never share diagnostic text', async () => {
  const first = acp();
  const second = acp();
  first.p.stderr.emit('data', 'first');
  second.p.emit('exit', 1, null);
  first.p.emit('exit', 1, null);
  assert.equal(second.a.exited.stderr, '');
  assert.equal(first.a.exited.stderr, 'first');
  const a = await claude('first');
  const b = await claude('second');
  a.options.stderr('first');
  b.options.stderr('second');
  await b.fail();
  await a.fail();
  assert.equal(a.reports.find((e: any) => e.kind === 'error').stderr, 'first');
  assert.equal(b.reports.find((e: any) => e.kind === 'error').stderr, 'second');
});

test('Codex can retry a failed spawn and a replacement without stderr reports an empty tail', () => {
  const t = codex();
  t.s.start();
  const old = t.children[0];
  old.stderr.emit('data', 'could not start');
  old.pid = undefined;
  old.emit('error', new Error('ENOENT'));
  t.s.start();
  old.stderr.emit('data', 'late');
  t.children[1].emit('exit', 1, null);
  assert.equal(t.reports.at(-1).stderr, '');
});

test('split Unicode chunks recombine before clipping, with no unpaired low surrogate at the budget edge', () => {
  const { StderrTail } = require('../electron/harness/stderrTail.cjs');
  const tail = new StderrTail(4);
  tail.push('abc\uD83D');
  tail.push('\uDE00');
  assert.equal(tail.text, 'bc😀');
  tail.push('xyz');
  assert.equal(tail.text, 'xyz');
  tail.push('a'.repeat(1_000_000));
  assert.equal(tail.text, 'aaaa');
});

test('old Codex stderr after disposal and duplicate ACP terminal events publish nothing new', () => {
  const t = codex();
  t.s.start();
  t.children[0].stderr.emit('data', 'before');
  t.s.stop();
  t.children[0].stderr.emit('data', 'after');
  t.children[0].emit('exit', 1, null);
  assert.equal(held(t.s.stderrTail), 'before');
  assert.equal(t.reports.length, 1);
  const { a, p } = acp();
  const exits: any[] = [];
  a.on('exit', (e: any) => exits.push(e));
  p.stderr.emit('data', 'failure');
  p.emit('exit', 1, null);
  p.emit('error', new Error('late error'));
  assert.equal(exits.length, 1);
  assert.equal(exits[0].stderr, 'failure');
});

test('Claude reports plain failures but a replaced session cannot publish its old error', async () => {
  const plain = await claude('plain');
  plain.options.stderr('plain error detail');
  await plain.fail('plain failure');
  assert.equal(plain.reports.find((e: any) => e.kind === 'error').stderr, 'plain error detail');
  const old = await claude('old');
  old.s.replaced = true;
  old.options.stderr('old error detail');
  await old.fail();
  assert.equal(old.reports.filter((e: any) => e.kind === 'error').length, 0);
});
