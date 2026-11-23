// While the gate is closed (not signed in, host.enabled killed, or a packaged build whose gate has not opened yet) the app must look as it did before Host existed: main's Host wiring, started the way main starts it with the gate closed, runs no process, opens no socket, writes no file, starts no timer and takes no POSIX-only path (so Windows and Linux start the same), and every answer a chat's send, stop, permission and event path asks of it says "this Mac".
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { watchResources } from './support/resourceWatch.ts';

const require = createRequire(import.meta.url);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-gate-closed-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

/** What a recorded call was given: its first two arguments, short, so a failure names the command or path. */
const detailOf = (args: unknown[]) =>
  args
    .slice(0, 2)
    .map((a) => (typeof a === 'string' ? a : Array.isArray(a) ? a.join(' ') : typeof a))
    .join(', ')
    .slice(0, 200);
/** The first stack frame outside node's internals and this test: the code that made the call. */
const callerOf = (stack: string | undefined) =>
  (stack ?? '')
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .find((l) => !l.includes('node:') && !l.includes('hostGateClosed.invariant.test.ts')) ?? 'unknown';
const details: string[] = [];

// what a closed gate must never do, recorded from before any Host module loads (modules that destructure these at load get the spies)
const effects: string[] = [];
const spy = (target: any, name: string, label = `${target === fs ? 'fs' : target === net ? 'net' : 'child_process'}.${name}`) => {
  if (typeof target[name] !== 'function') return;
  const real = target[name];
  // recorded, then run for real: the module loader itself reads files, so nothing may be stubbed out
  mock.method(target, name, function (this: unknown, ...args: unknown[]) {
    effects.push(label);
    details.push(`${label}(${detailOf(args)}) from ${callerOf(new Error().stack)}`);
    return real.apply(this, args);
  });
};
for (const n of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) spy(childProcess, n);
for (const n of ['connect', 'createConnection', 'createServer']) spy(net, n);
// a timer or a watcher the wiring starts, when it starts it (not a count taken later, which also sees what node's runner opens)
for (const n of ['watch', 'watchFile', 'readFile', 'createReadStream', 'createWriteStream']) spy(fs, n);
for (const [mod, names] of [
  [http, ['request', 'get']],
  [https, ['request', 'get']],
  [dgram, ['createSocket']],
] as const)
  for (const n of names) spy(mod, n, `${mod === http ? 'http' : mod === https ? 'https' : 'dgram'}.${n}`);
for (const n of ['setTimeout', 'setInterval', 'setImmediate'] as const) spy(globalThis, n, `global.${n}`);
// Electron itself: on a machine without its binary (CI's Linux jobs) loading it runs electron/install.js, and in the app it
// is a load a closed gate has no reason to make; recorded on every machine, whether or not the binary is there
const Module = require('node:module');
const realLoad = Module._load;
mock.method(Module, '_load', function (this: unknown, request: string, ...rest: unknown[]) {
  if (request === 'electron') {
    effects.push('require(electron)');
    details.push(`require(electron) from ${callerOf(new Error().stack)}`);
    return {};
  }
  return realLoad.call(this, request, ...rest);
});
for (const n of ['writeFileSync', 'writeFile', 'appendFileSync', 'mkdirSync', 'mkdir', 'renameSync', 'chmodSync', 'mkdtempSync'])
  spy(fs, n);

// a Windows-shaped process: no uid, no unix user info, another platform name
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const getuid = (process as any).getuid;
Object.defineProperty(process, 'platform', { value: 'win32' });
(process as any).getuid = undefined;
mock.method(os, 'userInfo', () => {
  effects.push('os.userInfo');
  throw new Error('no unix user on this platform');
});

// Include import-time effects too: moving an eager dependency to module scope must not evade the guard.
const loaded = effects.length;
const { register } = require('../electron/app/ipc/host.cjs');
const { remoteRoutes, hostOfChat } = require('../electron/host/wiring.cjs');
const { hostAccess } = require('../electron/host/access.cjs');
const { harnessKeys } = require('../shared/killSwitch.cjs');

const handlers = new Map<string, (...a: any[]) => any>();
const once = new Map<string, () => void>();
const live: any = {};
// the timers, sockets and watchers register itself opens: recorded by who creates them, so nothing node's runner or reporter opens in the
// same process (an Immediate of theirs) is blamed on the Host wiring (#5223); `after` is read in the same synchronous turn
const repo = path.resolve(import.meta.dirname, '..');
const watching = watchResources(['electron', 'shared', 'host', 'core'].map((d) => path.join(repo, d) + path.sep));
register(
  { handle: (c: string, f: any) => handlers.set(c, f) },
  {
    live,
    app: { getPath: () => dir, isPackaged: true, once: (e: string, f: () => void) => once.set(e, f) },
    shell: { openExternal: async () => undefined },
    shellEnv: { childEnv: () => ({}) },
    broadcastAll: () => effects.push('broadcast'),
  },
);
const left = watching.stop();

test('the gate is closed by default, and registering the Host wiring does nothing a user would notice', () => {
  assert.equal(hostAccess(), false);
  assert.deepEqual(effects.slice(loaded), [], `no process, socket, file or user lookup: ${details.slice(loaded).join('; ')}`);
  assert.deepEqual(
    left.opened,
    [],
    `no timer, socket or watcher is left running by register (started meanwhile by others: ${left.ambient.join('; ') || 'none'})`,
  );
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing is written to the data folder');
});

test('every Host channel answers cheaply and inertly: the gate, an empty list, no owner, or a not_allowed refusal', async () => {
  assert.equal(handlers.get('host:access')!(), false);
  assert.deepEqual(handlers.get('host:machines')!(), { machines: [], resolved: true });
  assert.equal(handlers.get('host:owner')!({}, 'acp:kimi:u1'), null);
  assert.deepEqual(handlers.get('host:remoteChats')!({}), []);
  assert.deepEqual(handlers.get('host:attentions')!({}), {});
  assert.deepEqual(await handlers.get('host:openSideChat')!({}, 'acp:kimi:u1'), { value: null });
  const others = [...handlers].filter(
    ([c]) => !['host:access', 'host:machines', 'host:owner', 'host:remoteChats', 'host:attentions', 'host:openSideChat'].includes(c),
  );
  assert.ok(others.length > 5, 'the mutating channels exist and are checked');
  for (const [channel, fn] of others) {
    const out = await fn({}, 'ssh:box', { chatId: 'acp:kimi:u1', hostId: 'ssh:box', folder: '/x', harness: 'kimi' }, 'x');
    assert.equal(out?.error?.code, 'not_allowed', `${channel} refuses`);
  }
  assert.deepEqual(effects.slice(loaded), [], `and refusing touches nothing: ${details.slice(loaded).join('; ')}`);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a chat’s send, stop, permission, event and tool paths see this Mac for every chat id, on every harness', () => {
  for (const id of ['acp:kimi:u1', 'acp:host-claude:u2', 'acp:host-codex:u3', 'claude:u4', '019e0000-0000-7000-8000-000000000000']) {
    assert.equal(live.remoteSend(), null, 'no outbox, no remote send');
    assert.equal(live.remoteChats(), null, 'no followed chats');
    assert.equal(live.hostCapabilitiesOf(id), null, 'no machine scopes the tools');
    assert.equal(live.hostOwnership.get(id).hostId, 'local');
    assert.equal(hostOfChat(live, id), 'local');
  }
  const routes = remoteRoutes(live);
  assert.equal(routes.stop('acp:kimi:u1', 't1'), null, 'Stop stays on the local path');
  assert.equal(routes.answer('r1', 'allow'), null, 'a permission answer stays on the local path');
  assert.deepEqual(effects.slice(loaded), []);
  assert.deepEqual(fs.readdirSync(dir), [], 'reading ownership for a local chat creates no file');
});

test('quitting with nothing started disposes nothing and throws nothing', () => {
  assert.equal(once.size, 1);
  once.get('will-quit')!();
  assert.deepEqual(effects.slice(loaded), []);
});

test('the kill switch for a basic agent is unchanged: the tier and the harness’s own keys, for any id but a machine’s Claude Code or Codex', () => {
  for (const id of ['kimi', 'gemini', 'claude', 'codex', 'host', 'host-claude-x']) {
    assert.deepEqual(harnessKeys(`acp:${id}`), ['tier.basic.enabled', `harness.acp.${id}.enabled`], id);
  }
  assert.deepEqual(harnessKeys('claude'), ['harness.claude.enabled']);
  assert.deepEqual(harnessKeys('codex'), ['harness.codex.enabled']);
});

test('the process is put back', () => {
  Object.defineProperty(process, 'platform', platform);
  (process as any).getuid = getuid;
  mock.restoreAll();
  assert.equal(process.platform, os.platform());
});
