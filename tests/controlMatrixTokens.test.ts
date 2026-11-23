// The control matrix's `(chat, turn)` token cases (docs/control-plane/matrix.md, group N; design D1, step 2): every
// computer-use and browser-use action carries its chat's turn to its executor - the computer-use helper, Your Chrome, the
// in-app browser's action queue, the Codex plugin's in-app browser backend - and the executor refuses a token whose turn
// ended, was Stopped or crashed; the desktop and app locks are granted per token. The Registry, the turn ledger, the tool
// channels (Claude Code's SDK servers; sage-mcp's tool socket, which Codex threads and ACP sessions share), the helper
// client, Your Chrome, the action queue and the locks are the real modules; the helper, Chrome and the harnesses are fakes.
import { waitFor } from './support/waitFor.ts';
import { slowChrome } from './support/extension-wire.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { world, claudeSession, codexConnection } from './support/control-matrix-kit.ts';
import { deferred, tick } from './support/async-scenarios.ts';

export const GUARDS = ['electron/', 'shared/'];
const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { TurnTokens, callTurnThread } = require('../electron/capabilities/contract/turnTokens.cjs');
const { turnLedger } = require('../electron/capabilities/turnEnd.cjs');
const { guarded, unguarded, mayAct, currentToken, tokenLiveness, liveness } = require('../electron/capabilities/contract/actionGuard.cjs');
const { ComputerHelper, GIVES_BACK } = require('../electron/capabilities/computer.cjs');
const { ComputerUse } = require('../electron/capabilities/tools/computer.cjs');
const { DesktopControl } = require('../electron/capabilities/tools/desktop.cjs');
const { AppScopedControl } = require('../electron/capabilities/tools/appScoped.cjs');
const { NativeDesktopHolds } = require('../electron/capabilities/nativeDesktopHold.cjs');
const { ChromeChannel, chromeTools, spawnSpec } = require('../electron/capabilities/browser/extension.cjs');
const { BrowserTabs } = require('../electron/capabilities/browser/host.cjs');
const { IabBackend, mainIabBackends } = require('../electron/capabilities/browser/iabBackend.cjs');

async function until(ok: () => boolean) {
  await waitFor(ok, 'the fake to be reached').catch(() => {});
  assert.ok(ok(), 'waited for the fake to be reached');
}

/** Whether a call holding `token` may act now. */
const mayActWith = (token: any) => guarded({ token, current: (t: any) => tokensOf.current(t) }, () => mayAct());
let tokensOf: any = null;

/** Runs `fn` as a call of `chat`'s current turn, the way the Registry runs a handler. */
function inTurn<T>(tokens: any, chat: string, fn: () => T): T {
  return guarded({ token: tokens.issue(chat), current: (t: any) => tokens.current(t) }, fn);
}

/** Main's turn ledger over a Registry, as electron/app/sessions.cjs wires it. */
function ledgerOver(
  r: any,
  chatOf: (id: string) => string = (id) => id,
  rootOf?: (id: string) => string,
  threadOf?: (chatId: string) => string | null,
) {
  return turnLedger({
    rootOf,
    threadOf,
    steps: [],
    abortChat: (chatId: string, why: string) => r.abortChat(chatId, why),
    // main maps a Codex chat's own end (thread null) to its current thread; these tests end Codex turns by thread
    retire: (chatId: string, thread: string | null) => r.turns.retireTurn(chatId, thread),
    retireAll: (chatId: string) => r.turns.retire(chatId),
    chatOf,
    running: () => false,
    tracked: () => true,
  });
}

test("CM-N01: every call on every channel carries its chat's (chat, turn) token; the turn's end, Stop or a crash retires it", async () => {
  const w = world();
  const seen: Array<{ token: any; before: boolean; after: boolean }> = [];
  let gate: ReturnType<typeof deferred> | null = null;
  w.r.register({
    name: 'sage_turn_probe',
    policy: 'observe',
    handler: async () => {
      const s = { token: currentToken(), before: mayAct(), after: true };
      seen.push(s);
      if (gate) await gate.promise;
      s.after = mayAct();
      return 'ok';
    },
  });
  const retired: string[] = [];
  w.r.turns.onRetire((chat: string) => retired.push(chat));
  const ledger = ledgerOver(w.r, (thread) => (thread.startsWith('cx-') ? 'codex-chat' : thread));
  // as main wires it (agentTools.cjs): a Codex thread's calls keep that thread's turn
  w.r.setTurnThread((_chatId: string, segmentId: string) => (segmentId.startsWith('cx-') ? segmentId : null));

  // Claude Code: the SDK servers one CLI process gets
  const claude = claudeSession(w, { chatId: 'claude-chat', segmentId: 'claude:s1' });
  ledger.sessionPatch({ chatId: 'claude-chat', patch: { turn: 'running' } });
  gate = deferred();
  const call = claude.call('sage_turn_probe');
  await until(() => seen.length === 1);
  assert.deepEqual(seen[0].token, { chat: 'claude-chat', turn: 0 });
  assert.equal(seen[0].before, true);
  // the turn ends (the session goes idle) while the call is still running: its token is no longer current
  ledger.sessionPatch({ chatId: 'claude-chat', patch: { turn: 'idle' } });
  // a second report of the same end retires nothing more
  ledger.sessionPatch({ chatId: 'claude-chat', patch: { turn: 'idle' } });
  assert.deepEqual(retired, ['claude-chat']);
  gate.resolve(null);
  await call;
  assert.equal(seen[0].after, false, "the ended turn's call may no longer act");
  // the next turn: a new token, current
  gate = null;
  ledger.sessionPatch({ chatId: 'claude-chat', patch: { turn: 'running' } });
  await claude.call('sage_turn_probe');
  assert.equal(seen[1].token.chat, 'claude-chat');
  assert.ok(seen[1].token.turn > 0);
  assert.equal(seen[1].after, true);

  // Codex (and ACP: the same sage-mcp tool socket): Stop on the chat retires the turn at once
  const codex = codexConnection(w, (thread) => (thread.startsWith('cx-') ? 'codex-chat' : thread));
  const { thread } = await codex.startThread();
  const s = await codex.session(thread.id);
  assert.equal(s.owner.chatId, 'codex-chat');
  ledger.codexMessage({ method: 'turn/started', params: { threadId: thread.id } });
  gate = deferred();
  const stopped = s.call('sage_turn_probe');
  await until(() => seen.length === 3);
  assert.deepEqual(seen[2].token, { chat: 'codex-chat', thread: thread.id, turn: 0 });
  ledger.hooks.onInterrupt('codex-chat');
  gate.resolve(null);
  await stopped;
  assert.equal(seen[2].after, false);
  // a Codex turn/completed ends the next turn: its call is refused too
  gate = deferred();
  const ended = s.call('sage_turn_probe');
  await until(() => seen.length === 4);
  const before = retired.length;
  ledger.codexMessage({ method: 'turn/completed', params: { threadId: thread.id } });
  assert.equal(retired.length, before + 1);
  gate.resolve(null);
  await ended;
  assert.equal(seen[3].after, false);
  // the harness crashing retires the turn even after it ended
  gate = null;
  const crashTurn = w.r.turns.turnOf('codex-chat');
  await ledger.hooks.onCrash('codex-chat');
  assert.notEqual(w.r.turns.turnOf('codex-chat'), crashTurn);
  // a retired number is never issued again, to any chat
  const all = seen.map((x) => x.token.turn).filter((n) => n > 0);
  assert.equal(new Set(all).size, all.length);
});

test("CM-N02: the helper gets each request's (chat, turn) token and the revoked turns; an older helper is covered by main", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmn-'));
  const file = path.join(dir, 'h.sock');
  const got: any[] = [];
  // revoke: what turn.revoke answers (a newer helper's result, or an older helper's method_not_found)
  let revoke: any = { result: { released: false } };
  const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (d: string) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (m.method !== 'hello') got.push(m);
        const answer = m.method === 'turn.revoke' ? revoke : { result: { seconds: 0, version: '1' } };
        sock.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...answer }) + '\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(file, () => r()));
  try {
    const tokens = new TurnTokens();
    const helper = new ComputerHelper({ connectTo: file, callTimeoutMs: 2000 });
    // nothing is launched to revoke a turn
    await helper.revokeTurn('c1', 0);
    assert.equal(got.length, 0);
    await helper.start();
    // a request outside any call carries no token
    await helper.cursor();
    assert.equal(got.at(-1).turn, undefined);
    // a request of a call carries its chat's turn
    await inTurn(tokens, 'c1', () => helper.click(1, 2));
    assert.equal(got.at(-1).method, 'input.click');
    assert.deepEqual(got.at(-1).turn, { chat: 'c1', turn: 0 });
    // the turn is revoked in the helper, and requests that give the Mac back still go out for it
    await inTurn(tokens, 'c1', async () => {
      tokens.retire('c1');
      await helper.revokeTurn('c1', 0);
      assert.deepEqual(got.at(-1).params, { chat: 'c1', turn: 0 });
      // one Codex thread's turn: the helper revokes only that thread's tokens
      await helper.revokeTurn('c1', 0, 'cx-1');
      assert.deepEqual(got.at(-1).params, { chat: 'c1', turn: 0, thread: 'cx-1' });
      // main refuses the stale call's request itself, so an older helper that ignores the token acts on nothing
      await assert.rejects(helper.click(1, 2), { reason: 'aborted' });
      await helper.releaseControl();
    });
    assert.equal(got.at(-1).method, 'control.release');
    assert.deepEqual(got.at(-1).turn, { chat: 'c1', turn: 0 }, 'the helper lets it through: it gives the Mac back');
    assert.ok(GIVES_BACK.has('turn.revoke'));
    // an older helper without turn.revoke: left alone
    revoke = { error: { code: -32601, message: 'unknown method turn.revoke', data: { reason: 'method_not_found' } } };
    await helper.revokeTurn('c1', 1);
    // any other failure is the caller's to see
    revoke = { error: { code: -32602, message: 'chat, turn', data: { reason: 'invalid_params' } } };
    await assert.rejects(helper.revokeTurn('', 1), { reason: 'invalid_params' });
    helper.stop();
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CM-N03: the desktop lock is granted per token: one a turn kept after it ended is free again; a native hold's stays", async () => {
  const tokens = new TurnTokens();
  const calls: string[] = [];
  const helper = {
    acquireControl: async () => void calls.push('acquire'),
    releaseControl: async () => void calls.push('release'),
  };
  const cu = new ComputerUse({ helper, grants: null, broker: null, session: () => ({}), waitMs: 0, pollMs: 1 });
  const app = { name: 'Notes', bundleId: 'com.apple.Notes' };
  await inTurn(tokens, 'c1', () => cu.control('c1', app));
  assert.equal(cu.liveHolder(), 'c1');
  // the turn ends without letting go (its release failed or has not run yet): the lock is no longer c1's
  tokens.retire('c1');
  // another chat takes it: the stale lock is let go first
  await inTurn(tokens, 'c2', () => cu.control('c2', app));
  assert.equal(cu.controlling, 'c2');
  assert.deepEqual(calls, ['acquire', 'release', 'acquire']);
  // the same chat's next turn takes it afresh under its own token
  tokens.retire('c2');
  calls.length = 0;
  await inTurn(tokens, 'c2', () => cu.control('c2', app));
  assert.deepEqual(calls, ['release', 'acquire']);
  assert.equal(cu.liveHolder(), 'c2');
  // the desktop_* tools take it the same way (desktopGate.acquire)
  const d = new DesktopControl({ helper, cu, grants: null, broker: null });
  tokens.retire('c2');
  calls.length = 0;
  await inTurn(tokens, 'c3', () => d.acquire('c3', 'Notes'));
  assert.equal(cu.controlling, 'c3');
  assert.deepEqual(calls, ['release', 'acquire']);
  // a live holder still refuses another chat
  await assert.rejects(
    inTurn(tokens, 'c4', () => d.acquire('c4', 'Notes')),
    /Another chat is controlling this Mac/,
  );
  await cu.release('c3');
  // a native Codex program finds another chat's lock its turn kept: the lock is let go and the program takes the desktop
  await inTurn(tokens, 'c6', () => cu.control('c6', app));
  tokens.retire('c6');
  const busy: unknown[] = [];
  const holds = new NativeDesktopHolds({ cu, isNativeThread: () => true, chatOf: () => 'c7', onBusy: (...a: unknown[]) => busy.push(a) });
  holds.take('nat', 't1', 'Mail');
  assert.equal(cu.controlling, 'c7');
  assert.deepEqual(busy, []);
  await cu.release('c7');
  // a lock taken outside a call (a native Codex hold) has no token and stays until it is let go
  cu.controlling = 'c5';
  tokens.retire('c5');
  assert.equal(cu.liveHolder(), 'c5');
  cu.controlling = null;
  assert.equal(cu.liveHolder(), null);
});

test("CM-N04: app locks are granted per token: an app a turn kept after it ended is free for the chat's next turn and other chats", () => {
  const tokens = new TurnTokens();
  const events: string[] = [];
  const cu = { closed: false, liveHolder: () => null };
  const apps = new AppScopedControl({
    desktop: {},
    helper: {},
    cu,
    broker: {},
    onLock: (chatId: string, app: any, held: boolean) => events.push(`${chatId} ${app.name} ${held}`),
  });
  const notes = { name: 'Notes', bundleId: 'com.apple.Notes' };
  const mail = { name: 'Mail', bundleId: 'com.apple.mail' };
  inTurn(tokens, 'c1', () => {
    apps.lock('c1', notes, 1);
    apps.lock('c1', notes, 2);
    apps.lock('c1', mail, 3);
  });
  assert.equal(apps.lockedBy('com.apple.Notes', 'c2'), 'c1');
  assert.deepEqual(apps.lockedElsewhere('c2').sort(), ['com.apple.Notes', 'com.apple.mail']);
  assert.throws(() => inTurn(tokens, 'c2', () => apps.lock('c2', notes, 9)), /Another chat is working in Notes/);
  assert.equal(apps.busy(), true);
  tokens.retire('c1');
  // stale: the locks go, as their turn's end would have let them go, and keep nothing busy
  assert.equal(apps.busy(), false);
  assert.equal(apps.lockedBy('com.apple.Notes', 'c2'), null);
  assert.deepEqual(apps.lockedElsewhere('c2'), []);
  assert.deepEqual(events, ['c1 Notes true', 'c1 Mail true', 'c1 Notes false', 'c1 Mail false']);
  inTurn(tokens, 'c2', () => apps.lock('c2', notes, 9));
  assert.equal(apps.lockedBy('com.apple.Notes', 'c1'), 'c2');
  // a lock taken outside any call is not turn-scoped
  apps.lock('c3', mail, 4);
  tokens.retire('c3');
  assert.equal(apps.lockedBy('com.apple.mail', 'c1'), 'c3');
  assert.equal(apps.lockedBy(undefined, 'c1'), null);
});

test('CM-N05: Your Chrome: a click still being checked when its turn ends (no Stop) is never sent to Chrome', async () => {
  const chrome = slowChrome();
  const channel = new ChromeChannel({ fork: chrome.fork, spec: () => spawnSpec({ outputDir: '/o', env: {} }) });
  const grants = { require: async () => {}, act: async () => {} };
  const [click] = chromeTools({ channel, grants, schemas: [{ name: 'browser_click', inputSchema: { type: 'object' } }] });
  const r = new Registry();
  r.register(click);
  const ledger = ledgerOver(r);
  ledger.sessionPatch({ chatId: 'c1', patch: { turn: 'running' } });
  const res = r.invoke('c1', 'c1', 'sage_browser_click', { element: 'Buy', ref: 'e1' });
  await until(() => chrome.sent.length === 1);
  // the turn ends while Chrome answers the page check: no abort reaches the call, only the turn's end
  ledger.sessionPatch({ chatId: 'c1', patch: { turn: 'idle' } });
  chrome.replies.shift()!();
  const out = await res;
  assert.equal(out.ok, false);
  assert.match(out.error.message, /Stopped by the user before/);
  assert.deepEqual(chrome.sent, ['browser_snapshot'], 'the click never reached Chrome');
  channel.stopAll();
});

test("CM-N06: the in-app browser's action queue: an action whose turn ends while it waits for its place does nothing", async () => {
  const tokens = new TurnTokens();
  const tab: any = { queue: Promise.resolve() };
  const run = (fn: () => any) => BrowserTabs.prototype.run.call(null, tab, fn);
  const first = deferred();
  const ran: string[] = [];
  // an earlier action holds the tab
  const busy = inTurn(tokens, 'c1', () => run(() => first.promise.then(() => ran.push('first'))));
  await tick();
  // the next action of the same turn queues behind it
  const queued = inTurn(tokens, 'c1', () => run(() => ran.push('second')));
  // and one outside any call (the user's own fill, a fit that gives the page back)
  const own = run(() => ran.push('own'));
  tokens.retire('c1');
  first.resolve(null);
  await busy;
  await assert.rejects(queued, { code: 'stopped', message: /built-in browser/ });
  await own;
  assert.deepEqual(ran, ['first', 'own']);
  // a call of the next turn runs
  await inTurn(tokens, 'c1', () => run(() => ran.push('next')));
  assert.deepEqual(ran, ['first', 'own', 'next']);
  // what a guard says now and later, read outside any call
  assert.equal(currentToken(), null);
  assert.equal(tokenLiveness(), null);
  assert.equal(liveness()(), true);
  assert.equal(
    unguarded(() => mayAct()),
    true,
  );
});

test("CM-N07: the Codex plugin's in-app browser commands carry their chat's turn: one under way when the native turn ends acts no more", async () => {
  const tokens = new TurnTokens();
  const gate = deferred();
  const seen: any[] = [];
  const acted: string[] = [];
  const host: any = {
    async create(chatId: string) {
      const tab: any = { id: 't1', queue: Promise.resolve() };
      seen.push({ chatId, token: currentToken(), before: mayAct() });
      await gate.promise;
      seen.push({ after: mayAct() });
      return BrowserTabs.prototype.run.call(host, tab, () => acted.push('create'));
    },
  };
  const b = new IabBackend({
    threadId: 'cx-1',
    chatOf: () => 'chat-x',
    tabs: () => host,
    grants: () => ({}),
    turns: () => tokens,
  });
  const p = b.handle('createTab', { session_id: 'cx-1' });
  await until(() => seen.length === 1);
  assert.deepEqual(seen[0], { chatId: 'chat-x', token: { chat: 'chat-x', thread: 'cx-1', turn: 0 }, before: true });
  tokens.retireTurn('chat-x', 'cx-1');
  gate.resolve(null);
  await assert.rejects(p, { code: 'stopped' });
  assert.deepEqual(seen[1], { after: false });
  assert.deepEqual(acted, []);
  // without the tokens (no Registry yet), a command is not turn-scoped
  const plain = new IabBackend({
    threadId: 'cx-2',
    chatOf: () => 'chat-y',
    tabs: () => ({ list: () => [], current: () => null }),
    grants: () => ({}),
  });
  assert.deepEqual(await plain.handle('getTabs', { session_id: 'cx-2' }), []);
  // main wires the Registry's tokens in
  const live: any = { capabilities: { turns: tokens } };
  const m = mainIabBackends({
    live,
    server: {},
    isFlagEnabled: () => false,
    shellEnv: { childEnv: () => ({}) },
    browserEnabled: () => true,
  });
  assert.equal(m.o.turns(), tokens);
  live.capabilities = null;
  assert.equal(m.o.turns(), null);
});

test('CM-N08: tokens: issued per chat, current until retired, never reissued; a failing listener does not stop the others', () => {
  const tokens = new TurnTokens();
  assert.equal(tokens.issue(null), null);
  assert.equal(tokens.current(null), true);
  const t0 = tokens.issue('a');
  assert.deepEqual(t0, { chat: 'a', turn: 0 });
  const heard: string[] = [];
  const off = tokens.onRetire(() => {
    throw new Error('listener failed');
  });
  tokens.onRetire((chat: string, turn: number) => heard.push(`${chat}:${turn}`));
  tokens.retire(null);
  tokens.retireTurn(null, 't');
  tokens.retire('a');
  assert.equal(tokens.current(t0), false);
  assert.equal(tokens.current(tokens.issue('a')), true);
  assert.equal(tokens.current(tokens.issue('b')), true);
  off();
  tokens.retire('a');
  assert.deepEqual(heard, ['a:0', 'a:1']);
  // a guard nested in a call's guard carries that call's token and dies with it
  inTurn(tokens, 'a', () =>
    guarded({ epoch: () => 0 }, () => {
      assert.deepEqual(currentToken(), { chat: 'a', turn: 2 });
      assert.equal(typeof tokenLiveness(), 'function');
      tokens.retire('a');
      assert.equal(mayAct(), false);
      assert.equal(tokenLiveness()!(), false);
    }),
  );
});

test("CM-N09: Codex sub-agent A's turn ends while sub-agent B and the parent are mid-call: B and the parent keep working; Stop refuses them all", async () => {
  const w = world();
  type Seen = { token: any; after: boolean | null };
  const seen = new Map<string, Seen>();
  const gates = new Map<string, ReturnType<typeof deferred>>();
  w.r.register({
    name: 'sage_thread_probe',
    policy: 'observe',
    schema: { type: 'object', properties: { tag: { type: 'string' } } },
    handler: async (args: { tag: string }) => {
      const s: Seen = { token: currentToken(), after: null };
      seen.set(args.tag, s);
      await gates.get(args.tag)?.promise;
      s.after = mayAct();
      return args.tag;
    },
  });
  const chatOf = (thread: string) => (thread.startsWith('cx-') ? 'chat' : thread);
  w.r.setTurnThread((_chatId: string, segmentId: string) => (segmentId.startsWith('cx-') ? segmentId : null));
  const ledger = ledgerOver(w.r, chatOf);
  tokensOf = w.r.turns;
  const codex = codexConnection(w, chatOf);
  // the parent thread and two sub-agent threads, each with its own sage-mcp session charged to the chat
  const parent = await codex.session((await codex.startThread()).thread.id);
  const a = await codex.session((await codex.startThread()).thread.id);
  const b = await codex.session((await codex.startThread()).thread.id);
  const threads = [parent, a, b].map((x) => x.owner.segmentId);
  for (const [i, t] of threads.entries())
    ledger.codexMessage({ method: 'turn/started', params: { threadId: t, turn: { id: `turn-${i}` } } });
  const inFlight = (tag: string, s: typeof parent) => {
    gates.set(tag, deferred());
    return s.call('sage_thread_probe', { tag });
  };
  const calls = [inFlight('parent', parent), inFlight('a', a), inFlight('b', b)];
  await until(() => seen.size === 3);
  assert.deepEqual(
    ['parent', 'a', 'b'].map((t) => seen.get(t)!.token.thread),
    threads,
  );
  // sub-agent A's turn completes: only A's own call is refused
  ledger.codexMessage({ method: 'turn/completed', params: { threadId: threads[1], turn: { id: 'turn-1' } } });
  // a late end of an older turn of B retires nothing
  ledger.codexMessage({ method: 'turn/completed', params: { threadId: threads[2], turn: { id: 'turn-old' } } });
  for (const tag of ['a', 'b', 'parent']) gates.get(tag)!.resolve(null);
  await Promise.all(calls);
  assert.equal(seen.get('a')!.after, false, "A's call is over with its turn");
  assert.equal(seen.get('b')!.after, true, 'B keeps working');
  assert.equal(seen.get('parent')!.after, true, 'the parent keeps working');
  // A's next turn gets a new, current token
  await a.call('sage_thread_probe', { tag: 'a2' });
  assert.equal(seen.get('a2')!.after, true);
  // Stop on the chat: every thread's call is refused
  const again = [inFlight('p3', parent), inFlight('a3', a), inFlight('b3', b)];
  await until(() => seen.size === 7);
  ledger.hooks.onInterrupt('chat');
  for (const tag of ['p3', 'a3', 'b3']) gates.get(tag)!.resolve(null);
  await Promise.all(again);
  assert.deepEqual(
    ['p3', 'a3', 'b3'].map((t) => seen.get(t)!.after),
    [false, false, false],
  );
  // a sub-agent that shares its parent's tool session sends its calls on the parent's turn: the parent's end leaves them
  // working while the sub-agent runs; the group's last end retires them
  const shared = ledgerOver(w.r, chatOf, (t) => (t.startsWith('cx-sub') ? threads[0] : t));
  shared.codexMessage({ method: 'turn/started', params: { threadId: threads[0], turn: { id: 'p' } } });
  shared.codexMessage({ method: 'turn/started', params: { threadId: 'cx-sub', turn: { id: 's' } } });
  // another sharing sub-agent's end retires only its own turn: the group still runs
  shared.codexMessage({ method: 'turn/started', params: { threadId: 'cx-sub2', turn: { id: 's2' } } });
  const groupTurn = w.r.turns.turnOf('chat', threads[0]);
  shared.codexMessage({ method: 'turn/completed', params: { threadId: 'cx-sub2', turn: { id: 's2' } } });
  assert.equal(w.r.turns.turnOf('chat', threads[0]), groupTurn);
  const viaParent = inFlight('sub', parent);
  await until(() => seen.has('sub'));
  shared.codexMessage({ method: 'turn/completed', params: { threadId: threads[0], turn: { id: 'p' } } });
  assert.equal(mayActWith(seen.get('sub')!.token), true, "the parent's end leaves the sub-agent's call working");
  shared.codexMessage({ method: 'turn/completed', params: { threadId: 'cx-sub', turn: { id: 's' } } });
  gates.get('sub')!.resolve(null);
  await viaParent;
  assert.equal(seen.get('sub')!.after, false, "the group's last end retires it");
  // the chat's own end (its session going idle) names its thread: the same group rule applies
  const own = ledgerOver(
    w.r,
    chatOf,
    (t) => t,
    (chatId) => (chatId === 'chat' ? threads[0] : null),
  );
  own.codexMessage({ method: 'turn/started', params: { threadId: threads[2], turn: { id: 'b' } } });
  const before = w.r.turns.turnOf('chat', threads[0]);
  own.sessionPatch({ chatId: 'chat', patch: { turn: 'idle' } });
  assert.notEqual(w.r.turns.turnOf('chat', threads[0]), before);
  assert.equal(w.r.turns.turnOf('chat', threads[2]) > 0, true);
  const b4 = inFlight('b4', b);
  await until(() => seen.has('b4'));
  own.sessionPatch({ chatId: 'other', patch: { turn: 'idle' } });
  gates.get('b4')!.resolve(null);
  await b4;
  assert.equal(seen.get('b4')!.after, true, "another chat's end leaves this chat's threads alone");
  // a turn/completed of a thread no chat owns retires nothing and throws nothing
  const lone = turnLedger({
    steps: [],
    abortChat: () => {},
    chatOf: () => {
      throw new Error('no chat');
    },
    running: () => false,
    tracked: () => true,
  });
  lone.codexMessage({ method: 'turn/completed', params: { threadId: 'stray', turn: { id: 't' } } });
  lone.codexMessage({ method: 'turn/started', params: { threadId: 'stray', turn: { id: 't' } } });
  lone.codexMessage({ method: 'turn/completed', params: { threadId: 'stray' } });
  await lone.hooks.onCrash('x');
  // the threads it remembers stay bounded: a turn's end, Stop and a crash forget them, and a thread no chat owns goes too
  const retiredHere: string[] = [];
  const mixed = turnLedger({
    steps: [],
    abortChat: () => {},
    retire: (chatId: string, thread: string | null) => retiredHere.push(`${chatId}/${thread}`),
    chatOf: (t: string) => {
      if (t === 'bad') throw new Error('no chat');
      return 'chat';
    },
    running: () => true,
    tracked: () => true,
  });
  for (const t of ['bad', 'good', 'other']) mixed.codexMessage({ method: 'turn/started', params: { threadId: t } });
  assert.equal(mixed.threadsHeld(), 3);
  mixed.codexMessage({ method: 'turn/completed', params: { threadId: 'good' } });
  assert.deepEqual(retiredHere, ['chat/good']);
  assert.equal(mixed.threadsHeld(), 2);
  mixed.hooks.onInterrupt('chat');
  assert.equal(mixed.threadsHeld(), 0);
  mixed.codexMessage({ method: 'turn/started', params: { threadId: 'good' } });
  await mixed.hooks.onCrash('elsewhere');
  assert.equal(mixed.threadsHeld(), 1, "another chat's crash keeps this chat's running thread");
  // the chat's last running thread ends: every token of the chat goes, so the per-thread turns stay bounded
  mixed.codexMessage({ method: 'turn/completed', params: { threadId: 'good' } });
  assert.deepEqual(retiredHere.at(-1), 'chat/null');
  // the chat's own end with no thread tools yet (rootOf throws) retires nothing and throws nothing
  const early = turnLedger({
    steps: [],
    abortChat: () => {},
    retire: (chatId: string, thread: string | null) => retiredHere.push(`early ${chatId}/${thread}`),
    chatOf: (t: string) => t,
    rootOf: () => {
      throw new Error('no thread tools');
    },
    threadOf: () => 'thr',
    running: () => false,
    tracked: () => true,
  });
  await early.end('c');
  assert.equal(
    retiredHere.some((x) => x.startsWith('early')),
    false,
  );
  // the chat's own end names no turn: it leaves a turn Codex reported started (a late end of an older turn must not
  // refuse the new one's calls); that turn's own completion retires it
  const late = turnLedger({
    steps: [],
    abortChat: () => {},
    retire: (chatId: string, thread: string | null) => retiredHere.push(`late ${chatId}/${thread}`),
    chatOf: (t: string) => (t === 'thr' ? 'c' : t),
    threadOf: () => 'thr',
    running: () => false,
    tracked: () => true,
  });
  late.codexMessage({ method: 'turn/started', params: { threadId: 'thr', turn: { id: 'new' } } });
  await late.end('c');
  assert.equal(
    retiredHere.some((x) => x.startsWith('late')),
    false,
  );
  late.codexMessage({ method: 'turn/completed', params: { threadId: 'thr', turn: { id: 'new' } } });
  assert.equal(retiredHere.at(-1), 'late c/null');
});

const { codexCallThread } = require('../electron/capabilities/channels/codexConfig.cjs');

/** A Codex call's `_meta`, as Codex sends it: its turn metadata names the session's thread, and a sub-agent's own. */
const codexMeta = (session: string, thread?: string, asText = false) => {
  const m = thread
    ? { session_id: session, thread_id: thread, thread_source: 'subagent', turn_id: 't' }
    : { session_id: session, thread_id: session, thread_source: 'user', turn_id: 't' };
  return { 'x-codex-turn-metadata': asText ? JSON.stringify(m) : m };
};

test("CM-N10: sub-agents sharing their parent's tool session: each call names its thread, so the parent's end refuses only the parent's leftover call", async () => {
  const w = world();
  type Seen = { token: any; after: boolean | null };
  const seen = new Map<string, Seen>();
  const gates = new Map<string, ReturnType<typeof deferred>>();
  w.r.register({
    name: 'sage_thread_probe',
    policy: 'observe',
    schema: { type: 'object', properties: { tag: { type: 'string' } } },
    handler: async (args: { tag: string }) => {
      const s: Seen = { token: currentToken(), after: null };
      seen.set(args.tag, s);
      await gates.get(args.tag)?.promise;
      s.after = mayAct();
      return args.tag;
    },
  });
  tokensOf = w.r.turns;
  const chatOf = (thread: string) => (thread.startsWith('cx-') ? 'chat' : thread);
  const codex = codexConnection(w, chatOf);
  // as main wires it (agentTools.cjs, sessions.cjs): a call's thread from its turn metadata
  w.r.setTurnThread((chatId: string, segmentId: string, meta: unknown) => codex.inj.turnThreadOf(chatId, segmentId, meta));
  const parentId = (await codex.startThread()).thread.id;
  const turnEnds = turnLedger({
    steps: [],
    abortChat: (chatId: string, why: string) => w.r.abortChat(chatId, why),
    retire: (chatId: string, thread: string | null) => w.r.turns.retireTurn(chatId, thread),
    retireAll: (chatId: string) => w.r.turns.retire(chatId),
    chatOf,
    rootOf: (t: string) => (t.startsWith('cx-sub') ? parentId : t),
    ridden: (chatId: string, thread: string) => w.r.turns.ridden(chatId, thread),
    running: () => false,
    tracked: () => true,
  });
  const parent = await codex.session(parentId);
  for (const [t, turn] of [
    [parentId, 'p'],
    ['cx-subA', 'a'],
    ['cx-subB', 'b'],
  ])
    turnEnds.codexMessage({ method: 'turn/started', params: { threadId: t, turn: { id: turn } } });
  const inFlight = (tag: string, meta?: any) => {
    gates.set(tag, deferred());
    return parent.call('sage_thread_probe', { tag }, meta);
  };
  // the parent's own call (its metadata as JSON text), and each sub-agent's, all over the parent's one session
  const calls = [
    inFlight('parent', codexMeta(parentId, undefined, true)),
    inFlight('a', codexMeta(parentId, 'cx-subA')),
    inFlight('b', codexMeta(parentId, 'cx-subB')),
  ];
  await until(() => seen.size === 3);
  assert.deepEqual(
    ['parent', 'a', 'b'].map((t) => seen.get(t)!.token.thread),
    [parentId, 'cx-subA', 'cx-subB'],
  );
  assert.equal(w.r.turns.ridden('chat', parentId), false, "every call on the parent's turn named its thread");
  // the parent's turn ends while both sub-agents still run: its own leftover call is refused at once, theirs keep working
  turnEnds.codexMessage({ method: 'turn/completed', params: { threadId: parentId, turn: { id: 'p' } } });
  assert.equal(mayActWith(seen.get('parent')!.token), false, "the parent's leftover call is refused at its turn's end");
  assert.equal(mayActWith(seen.get('a')!.token), true);
  // sub-agent A's end refuses A's call only
  turnEnds.codexMessage({ method: 'turn/completed', params: { threadId: 'cx-subA', turn: { id: 'a' } } });
  for (const tag of ['parent', 'a', 'b']) gates.get(tag)!.resolve(null);
  await Promise.all(calls);
  assert.equal(seen.get('parent')!.after, false, "the parent's leftover call is over with the parent's turn");
  assert.equal(seen.get('a')!.after, false, "A's call is over with A's turn");
  assert.equal(seen.get('b')!.after, true, 'B keeps working past the parent');
  // the chat's last running thread ends: every token of the chat goes
  const b2 = inFlight('b2', codexMeta(parentId, 'cx-subB'));
  await until(() => seen.has('b2'));
  turnEnds.codexMessage({ method: 'turn/completed', params: { threadId: 'cx-subB', turn: { id: 'b' } } });
  gates.get('b2')!.resolve(null);
  await b2;
  assert.equal(seen.get('b2')!.after, false);
  // a call on the parent's session that names no thread may be a sharing sub-agent's (a Codex that sends no turn
  // metadata): the parent's end then keeps its turn for the spawn group, as before
  turnEnds.codexMessage({ method: 'turn/started', params: { threadId: parentId, turn: { id: 'p2' } } });
  turnEnds.codexMessage({ method: 'turn/started', params: { threadId: 'cx-subA', turn: { id: 'a2' } } });
  const again = [inFlight('p3', codexMeta(parentId)), inFlight('a3', codexMeta(parentId, 'cx-subA')), inFlight('r3')];
  await until(() => seen.has('p3') && seen.has('a3') && seen.has('r3'));
  assert.equal(seen.get('r3')!.token.thread, parentId);
  assert.equal(w.r.turns.ridden('chat', parentId), true);
  turnEnds.codexMessage({ method: 'turn/completed', params: { threadId: parentId, turn: { id: 'p2' } } });
  assert.equal(mayActWith(seen.get('r3')!.token), true, "the unnamed call keeps working while the parent's group runs");
  // Stop still refuses every thread's call
  turnEnds.hooks.onInterrupt('chat');
  for (const tag of ['p3', 'a3', 'r3']) gates.get(tag)!.resolve(null);
  await Promise.all(again);
  assert.deepEqual(
    ['p3', 'a3', 'r3'].map((t) => seen.get(t)!.after),
    [false, false, false],
  );
  assert.equal(w.r.turns.ridden('chat', parentId), false, 'Stop forgets what rode on the turns');
});

test("CM-N11: a call's thread is read only from Codex's turn metadata, never across chats; ACP and unnamed calls keep their session's turn", () => {
  // what Codex puts in a call's _meta: an object or the same as JSON text; a sub-agent's own thread with thread_source
  assert.deepEqual(codexCallThread(codexMeta('s', 'sub')), { thread: 'sub', session: 's', named: true });
  assert.deepEqual(codexCallThread(codexMeta(' s ', undefined, true)), { thread: 's', session: 's', named: true });
  // with no thread_source it doesn't say whose call it is; a sub-agent's that names no thread is only its session's
  assert.deepEqual(codexCallThread({ 'x-codex-turn-metadata': { session_id: 's', thread_id: 'x' } }), {
    thread: 's',
    session: 's',
    named: false,
  });
  assert.deepEqual(codexCallThread({ 'x-codex-turn-metadata': { session_id: 's', thread_id: ' ', thread_source: 'subagent' } }), {
    thread: 's',
    session: 's',
    named: false,
  });
  assert.deepEqual(codexCallThread({ 'x-codex-turn-metadata': { thread_source: 'user' } }), { thread: null, session: null, named: false });
  for (const meta of [null, undefined, 'x', [], {}, { 'x-codex-turn-metadata': '{not json' }, { 'x-codex-turn-metadata': [1] }])
    assert.deepEqual(codexCallThread(meta), { thread: null, session: null, named: false });

  const w = world();
  const chatOf = (thread: string) => {
    if (thread === 'boom') throw new Error('no chat');
    if (thread === 'cx-other') return 'other';
    return thread.startsWith('cx-') ? 'chat' : thread;
  };
  const codex = codexConnection(w, chatOf);
  const ownThread = 'cx-1';
  codex.resume(ownThread);
  const rides = { thread: ownThread, named: false };
  // ACP: a session that is not a Codex thread's keeps the chat's one turn, whatever its calls carry
  assert.equal(codex.inj.turnThreadOf('acp-chat', 'acp:1', codexMeta('acp:1', 'cx-2')), null);
  // no metadata, or metadata that doesn't say whose call it is: it rides on the session's thread
  assert.deepEqual(codex.inj.turnThreadOf('chat', ownThread), rides);
  assert.deepEqual(codex.inj.turnThreadOf('chat', ownThread, { other: 1 }), rides);
  assert.deepEqual(codex.inj.turnThreadOf('chat', ownThread, { 'x-codex-turn-metadata': { session_id: ownThread } }), rides);
  // the session thread's own call, and a sub-agent of the chat
  assert.deepEqual(codex.inj.turnThreadOf('chat', ownThread, codexMeta(ownThread)), { thread: ownThread, named: true });
  assert.deepEqual(codex.inj.turnThreadOf('chat', ownThread, codexMeta(ownThread, 'cx-2')), { thread: 'cx-2', named: true });
  // another chat's thread, a thread the chat has not linked (its end could not be placed), or one whose chat can't be
  // found is never charged its own turn here: it rides on the session's thread
  assert.deepEqual(codex.inj.turnThreadOf('chat', ownThread, codexMeta(ownThread, 'cx-other')), rides);
  assert.deepEqual(codex.inj.turnThreadOf('chat', ownThread, codexMeta(ownThread, 'fresh')), rides);
  assert.deepEqual(codex.inj.turnThreadOf('chat', ownThread, codexMeta(ownThread, 'boom')), rides);

  // what rode on a turn is kept per thread and per turn: the thread's next turn, and the chat's, start with none
  const tokens = new TurnTokens();
  tokens.issue('c', null, { named: false });
  tokens.issue('c', 't1');
  assert.equal(tokens.ridden('c', 't1'), false);
  tokens.issue('c', 't1', { named: false });
  tokens.issue('c', 't2', { named: false });
  assert.equal(tokens.ridden('c', 't1'), true);
  tokens.retireTurn('c', 't1');
  assert.deepEqual([tokens.ridden('c', 't1'), tokens.ridden('c', 't2')], [false, true]);
  tokens.retireTurn('c', 't2');
  assert.equal(tokens.riders.size, 0, 'nothing is kept for a chat with no ridden turn');
  tokens.retireTurn('c', 't3');
  tokens.issue('c', 't3', { named: false });
  tokens.retire('c');
  assert.equal(tokens.ridden('c', 't3'), false);
  // a rule that answers a bare thread id names no call's thread
  assert.deepEqual(callTurnThread('t'), { thread: 't', named: false });
  assert.deepEqual(callTurnThread(null), { thread: null, named: false });
  assert.deepEqual(callTurnThread({ thread: 't', named: true }), { thread: 't', named: true });
  assert.deepEqual(callTurnThread({ thread: null } as any), { thread: null, named: false });

  // a ledger told nothing of what rode on a turn keeps the spawn-group rule
  const retired: string[] = [];
  const unsure = turnLedger({
    steps: [],
    abortChat: () => {},
    retire: (chatId: string, thread: string | null) => retired.push(`${chatId}/${thread}`),
    chatOf: () => 'chat',
    rootOf: (t: string) => (t === 'sub' ? 'root' : t),
    running: () => false,
    tracked: () => true,
  });
  unsure.codexMessage({ method: 'turn/started', params: { threadId: 'root', turn: { id: 'r' } } });
  unsure.codexMessage({ method: 'turn/started', params: { threadId: 'sub', turn: { id: 's' } } });
  unsure.codexMessage({ method: 'turn/completed', params: { threadId: 'root', turn: { id: 'r' } } });
  assert.deepEqual(retired, [], "the root's turn waits for its group");
});
