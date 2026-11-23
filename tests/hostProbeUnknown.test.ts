// A sign-in probe that cannot tell is not "signed out" (#5118): the CLI timing out under load, failing to start or printing no status reads as unknown, `status` keeps the last definite answer or says the agent is being checked, and a Codex send is refused only on a definite signed-out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { UNSURE_MS, listHarnesses, probeHarness } from '../host/src/harnessState.mjs';
// @ts-ignore: plain ESM without declarations
import { harnessList } from '../host/src/harnessList.mjs';
import { createCodexFamily } from '../host/src/codexFamily.mjs';

const killed = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });
const cannotStart = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
const exited1 = Object.assign(new Error('exit 1'), { code: 1 });
const JSON_IN = JSON.stringify({ loggedIn: true });
const JSON_OUT = JSON.stringify({ loggedIn: false });
const which = (name: string) => `/bin/${name}`;
/** A CLI stand-in answering each probe from `answers[basename args]`; the keychain asked too is recorded. */
const execOf =
  (answers: Record<string, [any, string]>, asked: string[] = []): any =>
  (bin: string, args: string[], _o: unknown, cb: Function) => {
    asked.push(path.basename(bin));
    const [error, out] = answers[`${path.basename(bin)} ${args.join(' ')}`] ?? [null, ''];
    cb(error, out, '');
  };

test('Claude Code: only a status that says so is signed out; a timeout, a CLI that cannot start and unreadable output are unknown', async () => {
  const ask = (a: [any, string]) => probeHarness('claude', { env: {}, which, exec: execOf({ 'claude auth status': a }) });
  assert.equal(await ask([null, JSON_IN]), true);
  assert.equal(await ask([null, JSON_OUT]), false);
  assert.equal(await ask([exited1, JSON_OUT]), false, 'a CLI that exits non-zero while printing its status still answered');
  assert.equal(await ask([killed, '']), null);
  assert.equal(await ask([cannotStart, '']), null);
  assert.equal(await ask([null, 'Unexpected banner']), null);
  assert.equal(await probeHarness('claude', { env: {}, which: () => null }), false, 'not installed is not signed in');
});

test('Codex: a CLI that exits non-zero is signed out; one killed or unable to start is unknown', async () => {
  const ask = (a: [any, string]) => probeHarness('codex', { env: {}, which, exec: execOf({ 'codex login status': a }) });
  assert.equal(await ask([null, 'Logged in']), true);
  assert.equal(await ask([exited1, 'Not logged in']), false);
  assert.equal(await ask([new Error('Not logged in'), '']), false);
  assert.equal(await ask([killed, '']), null);
  assert.equal(await ask([cannotStart, '']), null);
});

test('status keeps the last definite answer when a probe cannot tell, says "checking" when it never had one, and asks the keychain only after a definite signed-out', async () => {
  const memo = new Map<string, boolean>();
  const last = { get: (id: string) => memo.get(id), set: (id: string, v: boolean) => memo.set(id, v), since: () => 0, clear: () => {} };
  const now = () => 1_000; // inside the wait, so an agent never heard from reads "checking"
  const asked: string[] = [];
  const list = (answers: Record<string, [any, string]>) =>
    listHarnesses({ env: {}, which, acp: [], exec: execOf(answers, asked), platform: 'darwin', last, now });
  const pick = (l: any[], id: string) => l.find((h) => h.id === id);

  // never answered: being checked, not signed out, and the keychain is not asked about
  const first = await list({ 'claude auth status': [killed, ''], 'codex login status': [killed, ''] });
  assert.deepEqual(pick(first, 'claude'), { id: 'claude', detected: true, signedIn: false, checking: true });
  assert.deepEqual(pick(first, 'codex'), { id: 'codex', detected: true, signedIn: false, checking: true });
  assert.equal(asked.includes('security'), false);

  // a definite answer is kept ...
  const good = await list({ 'claude auth status': [null, JSON_IN], 'codex login status': [null, 'ok'] });
  assert.deepEqual(pick(good, 'claude'), { id: 'claude', detected: true, signedIn: true });
  // ... and stands for an unknown one after it: two busy chats do not flip the agent to signed out
  const busy = await list({ 'claude auth status': [killed, ''], 'codex login status': [cannotStart, ''] });
  assert.deepEqual(pick(busy, 'claude'), { id: 'claude', detected: true, signedIn: true });
  assert.deepEqual(pick(busy, 'codex'), { id: 'codex', detected: true, signedIn: true });

  // a definite signed-out replaces it, and only then is the keychain asked
  const out = await list({ 'claude auth status': [null, JSON_OUT], 'codex login status': [exited1, ''] });
  assert.equal(pick(out, 'claude').signedIn, false);
  assert.equal(pick(out, 'claude').checking, undefined);
  assert.equal(pick(out, 'codex').signedIn, false);
  assert.equal(asked.includes('security'), true);
});

test('a Host keeps its last answers apart from another Host’s, in its own data folder', async () => {
  const dirs = [fs.mkdtempSync(path.join(os.tmpdir(), 'probe-a-')), fs.mkdtempSync(path.join(os.tmpdir(), 'probe-b-'))];
  try {
    const call = (dir: string, claude: [any, string]) =>
      harnessList({
        paths: { dataDir: dir },
        env: {},
        which,
        signedIn: { get: () => false },
        noSignIn: undefined,
        exec: execOf({ 'claude auth status': claude, 'codex login status': [killed, ''] }),
      });
    const find = async (p: Promise<any[]>) => (await p).find((h) => h.id === 'claude');
    // the same Host keeps its answer, and a second Host starts from nothing
    const a1 = await find(call(dirs[0], [null, JSON_IN]));
    assert.equal(a1.signedIn, true);
    assert.equal((await find(call(dirs[0], [killed, '']))).signedIn, true);
    assert.deepEqual(await find(call(dirs[1], [killed, ''])), { id: 'claude', detected: true, signedIn: false, checking: true });
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('a Codex send is refused as signed out only when the CLI said so; an unknown answer goes on and is asked again next time', async () => {
  const make = (answer: boolean | null, asked: number[]) => {
    const ctx: any = { emit() {}, send() {}, env: {} };
    return createCodexFamily({
      env: {},
      which: () => '/bin/codex',
      probe: (async () => (asked.push(1), answer)) as any,
      now: () => 1_000_000,
    })(ctx);
  };
  const asked: number[] = [];
  const unknown = make(null, asked);
  await unknown.check();
  await unknown.check();
  assert.equal(asked.length, 2, 'an unknown answer is not kept as a good one');
  await assert.rejects(make(false, []).check(), (e: any) => e.code === 'harness_not_configured');
});

test('a probe that never answers from the first try is "checking" only for a bounded wait, then "unsure", and is asked again until it answers (#5177)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-cold-'));
  try {
    const realNow = Date.now;
    let t = 5_000_000;
    Date.now = () => t;
    try {
      let answers: Record<string, [any, string]> = { 'claude auth status': [killed, ''], 'codex login status': [killed, ''] };
      const claude = async () =>
        (
          await harnessList({
            paths: { dataDir: dir },
            env: {},
            which,
            signedIn: { get: () => false },
            noSignIn: undefined,
            exec: execOf(new Proxy({}, { get: (_o, k: string) => answers[k] })),
          })
        ).find((h: any) => h.id === 'claude');
      assert.deepEqual(await claude(), { id: 'claude', detected: true, signedIn: false, checking: true });
      t += UNSURE_MS - 1;
      assert.equal((await claude())!.checking, true, 'still inside the wait');
      t += 1;
      assert.deepEqual(await claude(), { id: 'claude', detected: true, signedIn: false, unsure: true });
      // the background ask answers at last: the row is replaced by the real state
      answers = { 'claude auth status': [null, JSON_IN], 'codex login status': [null, 'ok'] };
      assert.deepEqual(await claude(), { id: 'claude', detected: true, signedIn: true });
      // and a later unknown keeps that answer, with the wait started over
      answers = { 'claude auth status': [killed, ''], 'codex login status': [killed, ''] };
      assert.equal((await claude())!.signedIn, true);
    } finally {
      Date.now = realNow;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a CLI that ignores its kill and never closes its pipes cannot hold the probe: the Host answers "unknown" after its own bound (#5177)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const killed: string[] = [];
  const hang: any = () => ({ kill: (sig: string) => void killed.push(sig) });
  const asked = probeHarness('codex', { env: {}, which, exec: hang });
  t.mock.timers.tick(5999);
  assert.deepEqual(killed, [], 'inside the CLI’s own timeout and the grace');
  t.mock.timers.tick(1);
  assert.equal(await asked, null);
  assert.deepEqual(killed, ['SIGKILL']);
  // a CLI that has already exited is not killed twice, and one that cannot be killed does not break the answer
  const gone: any = () => ({
    kill: () => {
      throw new Error('ESRCH');
    },
  });
  const second = probeHarness('claude', { env: {}, which, exec: gone });
  t.mock.timers.tick(6000);
  assert.equal(await second, null);
});
