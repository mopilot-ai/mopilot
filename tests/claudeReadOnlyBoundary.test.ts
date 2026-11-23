// Moving a Claude Code chat into or out of Read-only (dontAsk) reaches the CLI that runs its next message (#4648): the CLI's own
// confirmed mode, not a start-time flag or a stuck "busy" count, decides whether the process restarts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { waitFor } from './support/waitFor.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ro-boundary-'));
fs.writeFileSync(path.join(tmp, 'electron.cjs'), `module.exports = { app: { getPath: () => ${JSON.stringify(tmp)} } };`);
fs.writeFileSync(
  path.join(tmp, 'sdk.mjs'),
  'export const query = (args) => globalThis.__fakeQuery(args);\nexport const getSessionMessages = async () => [];',
);
const fakes: Record<string, string> = { electron: 'electron.cjs', '@anthropic-ai/claude-agent-sdk': 'sdk.mjs' };
registerHooks({
  resolve(specifier, context, next) {
    if (fakes[specifier]) return { url: pathToFileURL(path.join(tmp, fakes[specifier])).href, shortCircuit: true };
    return next(specifier, context);
  },
});

/** A CLI that reports its permission mode as the real one does (init, then a status per change) and answers each prompt. */
interface Fake {
  options: any;
  mode: string;
  modes: string[];
  closed: boolean;
  /** a mode change the CLI accepts without applying or reporting it */
  ignoreModeChange: boolean;
  /** prompts held: a steer folds into the running loop, so the next release ends both with one result */
  hold: boolean;
  /** prompts it reads and says nothing about (a CLI slow to start the turn) */
  silent: boolean;
  push(m: any): void;
}
const queries: Fake[] = [];
(globalThis as any).__fakeQuery = ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
  const out: any[] = [];
  let wake = () => {};
  const q: any = {
    options,
    mode: options.permissionMode,
    modes: [] as string[],
    closed: false,
    ignoreModeChange: false,
    hold: false,
    silent: false,
    push(m: any) {
      out.push(m);
      wake();
    },
    close() {
      q.closed = true;
      wake();
    },
    async interrupt() {},
    async getSettings() {
      return { applied: {} };
    },
    async setPermissionMode(mode: string) {
      q.modes.push(mode);
      if (q.ignoreModeChange) return;
      q.mode = mode;
      q.push({ type: 'system', subtype: 'status', permissionMode: mode });
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (out.length) yield out.shift();
        else if (q.closed) return;
        else await new Promise<void>((r) => (wake = r));
      }
    },
  };
  q.push({ type: 'system', subtype: 'init', permissionMode: q.mode });
  (async () => {
    for await (const _m of prompt) {
      if (q.silent) continue;
      q.push({ type: 'system', subtype: 'session_state_changed', state: 'running' });
      q.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });
      if (q.hold) continue;
      q.push({ type: 'result', subtype: 'success' });
      q.push({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
    }
  })();
  queries.push(q);
  return q;
};

const claude = createRequire(import.meta.url)('../electron/harness/claude/index.cjs').createClaudeHarness();
claude.timing.retireMs = 50;
const events: any[] = [];
claude.register({ handle: () => {} }, (channel: string, evt: any) => channel === 'claude:event' && events.push(evt));
const results = (key: string) => events.filter((e) => e.key === key && e.kind === 'message' && e.msg.type === 'result').length;
const opts = (sid: string, permission: string, basePermission = permission) => ({
  bin: process.execPath,
  sessionId: sid,
  resume: true,
  cwd: tmp,
  account: 'default',
  permission,
  basePermission,
});
const msg = (text: string) => ({ role: 'user', content: text });
const until = (what: string, ok: () => boolean) => waitFor(ok, what);

test('a steer the CLI folds into its running loop leaves nothing owed, so the next message moves a chat into Read-only on a fresh CLI', async () => {
  const key = 'claude:fold';
  const before = queries.length;
  await claude.send(key, opts('fold', 'full-access'), msg('one'));
  await until('the first reply', () => results(key) === 1);
  const cli = queries[before];
  cli.hold = true;
  await claude.send(key, opts('fold', 'full-access'), msg('long task'));
  await claude.send(key, opts('fold', 'full-access'), msg('steer'), 'now');
  // one result answers both prompts (#1834), then the CLI says it is idle
  cli.push({ type: 'result', subtype: 'success' });
  cli.push({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
  await until('the folded turn', () => results(key) === 2);
  await until('the settled turn', () => !claude.ownBusy(key) && queries.length === before + 1);
  await claude.send(key, opts('fold', 'read-only'), msg('read only now'));
  assert.equal(queries.length - before, 2, 'Read-only starts a CLI with its tool whitelist, as it does for any idle chat');
  assert.equal(queries[before + 1].options.permissionMode, 'dontAsk');
  assert.ok(queries[before + 1].options.allowedTools.includes('WebSearch'));
  await claude.turnApi.control(key, 'close');
});

test('a message sent right after a folded turn went idle waits out the grace, then moves the chat into Read-only on a fresh CLI (#4704)', async () => {
  const key = 'claude:fold-fast';
  const before = queries.length;
  await claude.send(key, opts('fold-fast', 'full-access'), msg('one'));
  await until('the first reply', () => results(key) === 1);
  const cli = queries[before];
  cli.hold = true;
  await claude.send(key, opts('fold-fast', 'full-access'), msg('long task'));
  await claude.send(key, opts('fold-fast', 'full-access'), msg('steer'), 'now');
  cli.push({ type: 'result', subtype: 'success' });
  cli.push({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
  await until('the folded turn', () => results(key) === 2);
  // no pause: the pick and the send come within the grace of the idle, as a fast client's do
  await claude.send(key, opts('fold-fast', 'read-only'), msg('read only now'));
  assert.equal(queries.length - before, 2, 'a Read-only message inside the grace still gets a CLI with its whitelist');
  assert.equal(queries[before + 1].options.permissionMode, 'dontAsk');
  assert.ok(queries[before + 1].options.allowedTools.includes('WebSearch'));
  await claude.turnApi.control(key, 'close');
});

test('two messages sent inside the same grace start one CLI between them, not one each', async () => {
  const key = 'claude:fold-two';
  const before = queries.length;
  await claude.send(key, opts('fold-two', 'full-access'), msg('one'));
  await until('the first reply', () => results(key) === 1);
  const cli = queries[before];
  cli.hold = true;
  await claude.send(key, opts('fold-two', 'full-access'), msg('long task'));
  await claude.send(key, opts('fold-two', 'full-access'), msg('steer'), 'now');
  cli.push({ type: 'result', subtype: 'success' });
  cli.push({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
  await until('the folded turn', () => results(key) === 2);
  await Promise.all([
    claude.send(key, opts('fold-two', 'read-only'), msg('first after')),
    claude.send(key, opts('fold-two', 'read-only'), msg('second after')),
  ]);
  assert.equal(queries.length - before, 2, 'one fresh CLI answers both');
  await claude.turnApi.control(key, 'close');
});

test('a chat a live mode change put into Read-only leaves it on a fresh CLI even when the old one ignores the change back', async () => {
  const key = 'claude:ignored';
  const before = queries.length;
  await claude.send(key, opts('ignored', 'full-access'), msg('one'));
  await until('the first reply', () => results(key) === 1);
  const cli = queries[before];
  // the turn start applied Read-only live (liveControls): the CLI confirms dontAsk, and it has no whitelist
  await claude.turnApi.control(key, 'setPermissionMode', 'read-only');
  await until('dontAsk confirmed', () => cli.mode === 'dontAsk');
  await claude.send(key, opts('ignored', 'read-only'), msg('two'));
  await until('the second reply', () => results(key) === 2);
  assert.equal(queries.length - before, 2, 'the whitelist is only set when a process starts');
  const second = queries[before + 1];
  // going back: the live change is applied first, and this CLI never takes it
  second.ignoreModeChange = true;
  await claude.turnApi.control(key, 'setPermissionMode', 'full-access');
  await claude.send(key, opts('ignored', 'full-access'), msg('three'));
  await until('the third reply', () => results(key) === 3);
  assert.equal(queries.length - before, 3, 'a CLI still in dontAsk is replaced, not trusted');
  assert.equal(queries[before + 2].options.permissionMode, 'bypassPermissions');
  assert.equal(queries[before + 2].mode, 'bypassPermissions');
  await claude.turnApi.control(key, 'close');
});

test('a CLI that confirmed dontAsk keeps it for a chat that wants Full access and a live change it never took, on any later message', async () => {
  const key = 'claude:live-only';
  const before = queries.length;
  await claude.send(key, opts('live-only', 'full-access'), msg('one'));
  await until('the first reply', () => results(key) === 1);
  const cli = queries[before];
  await claude.turnApi.control(key, 'setPermissionMode', 'read-only');
  await until('dontAsk confirmed', () => cli.mode === 'dontAsk');
  // out of Read-only with no whitelist to lose: this process started in Full access, but it now runs dontAsk
  cli.ignoreModeChange = true;
  await claude.send(key, opts('live-only', 'full-access'), msg('two'));
  await until('the reply', () => results(key) === 2);
  assert.equal(queries.length - before, 2);
  assert.equal(queries[before + 1].mode, 'bypassPermissions');
  await claude.turnApi.control(key, 'close');
});

test('a plan in a Read-only chat and an idle CLI with no report keep their process', async () => {
  const key = 'claude:plan-ro';
  const before = queries.length;
  await claude.send(key, opts('plan-ro', 'read-only'), msg('one'));
  await until('the first reply', () => results(key) === 1);
  // the CLI entered plan mode: its confirmed mode is plan, which says nothing about the whitelist it started with
  queries[before].push({ type: 'system', subtype: 'status', permissionMode: 'plan' });
  await claude.send(key, opts('plan-ro', 'plan', 'read-only'), msg('two'));
  await until('the plan reply', () => results(key) === 2);
  assert.equal(queries.length - before, 1);
  // a status from a sub-agent is not the process's mode
  queries[before].push({ type: 'system', subtype: 'status', permissionMode: 'bypassPermissions', parent_tool_use_id: 'toolu_1' });
  await claude.send(key, opts('plan-ro', 'read-only'), msg('three'));
  await until('the reply', () => results(key) === 3);
  assert.equal(queries.length - before, 1, 'still the Read-only process');
  await claude.turnApi.control(key, 'close');
});

const NATIVE: Record<string, string> = {
  'read-only': 'dontAsk',
  default: 'default',
  'auto-review': 'auto',
  'full-access': 'bypassPermissions',
};
for (const from of Object.keys(NATIVE)) {
  for (const to of Object.keys(NATIVE)) {
    test(`${from} to ${to}: the next message runs on a CLI the CLI itself confirms in ${NATIVE[to]}, with the whitelist only for Read-only`, async () => {
      const key = `claude:matrix-${from}-${to}`;
      const sid = `matrix-${from}-${to}`;
      await claude.send(key, opts(sid, from), msg('one'));
      await until('the first reply', () => results(key) === 1);
      // a turn start applies the pick live (ClaudeAdapter.beginTurn liveControls), then sends
      if (from !== to) await claude.turnApi.control(key, 'setPermissionMode', to);
      await claude.send(key, opts(sid, to), msg('two'));
      await until('the second reply', () => results(key) === 2);
      const cli = queries.at(-1)!;
      await until('the confirmed mode', () => cli.mode === NATIVE[to]);
      assert.equal(!!cli.options.allowedTools?.includes('Read'), to === 'read-only', 'only the Read-only process has the whitelist');
      await claude.turnApi.control(key, 'close');
    });
  }
}

const state = (cli: Fake, value: string, extra: object = {}) =>
  cli.push({ type: 'system', subtype: 'session_state_changed', state: value, ...extra });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('an idle of the turn that ended does not clear a prompt still queued behind it: the next message cannot replace the CLI under it', async () => {
  const key = 'claude:queued-behind';
  const before = queries.length;
  await claude.send(key, opts('queued-behind', 'full-access'), msg('one'));
  await until('the first reply', () => results(key) === 1);
  const cli = queries[before];
  cli.hold = true;
  await claude.send(key, opts('queued-behind', 'full-access'), msg('A'));
  await claude.send(key, opts('queued-behind', 'full-access'), msg('B'), 'now');
  // A ends and the CLI reports idle before it has read B, then it starts B
  cli.push({ type: 'result', subtype: 'success' });
  state(cli, 'idle');
  state(cli, 'running');
  cli.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'B' }] } });
  await wait(600);
  assert.equal(claude.ownBusy(key), true, 'B is still owed');
  await claude.send(key, opts('queued-behind', 'read-only'), msg('C'));
  assert.equal(queries.length - before, 1, 'the CLI running B is not replaced');
  cli.push({ type: 'result', subtype: 'success' });
  state(cli, 'idle');
  await until('B done', () => !claude.ownBusy(key));
  await claude.turnApi.control(key, 'close');
});

test('a sub-agent idle and a prompt sent while the grace runs leave what is owed to the turn that owes it', async () => {
  const key = 'claude:grace';
  const before = queries.length;
  await claude.send(key, opts('grace', 'full-access'), msg('one'));
  await until('the first reply', () => results(key) === 1);
  const cli = queries[before];
  cli.hold = true;
  await claude.send(key, opts('grace', 'full-access'), msg('A'));
  await claude.send(key, opts('grace', 'full-access'), msg('B'), 'now');
  cli.push({ type: 'result', subtype: 'success' });
  // a sub-agent's idle is not the process's
  state(cli, 'idle', { parent_tool_use_id: 'toolu_1' });
  await wait(600);
  assert.equal(claude.ownBusy(key), true);
  // the process's own idle, then a newer prompt before the grace ends: its own turn answers for it
  state(cli, 'idle');
  cli.hold = false;
  await claude.send(key, opts('grace', 'full-access'), msg('C'), 'now');
  await until('C answered', () => results(key) >= 3);
  await until('nothing owed once the CLI is idle again', () => !claude.ownBusy(key));
  await claude.turnApi.control(key, 'close');
});

test('a prompt sent after the idle, to a CLI that has not started on it yet, is still owed when the grace ends', async () => {
  const key = 'claude:slow-start';
  const before = queries.length;
  await claude.send(key, opts('slow-start', 'full-access'), msg('one'));
  await until('the first reply', () => results(key) === 1);
  const cli = queries[before];
  cli.hold = true;
  await claude.send(key, opts('slow-start', 'full-access'), msg('A'));
  await claude.send(key, opts('slow-start', 'full-access'), msg('B'), 'now');
  cli.push({ type: 'result', subtype: 'success' });
  state(cli, 'idle');
  // the idle has been read (the grace is running) when C goes in
  await wait(100);
  cli.silent = true;
  await claude.send(key, opts('slow-start', 'full-access'), msg('C'), 'now');
  await wait(600);
  assert.equal(claude.ownBusy(key), true, 'C is owed: the idle was about the turn before it');
  await claude.turnApi.control(key, 'close');
});
