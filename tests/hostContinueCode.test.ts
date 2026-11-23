// Getting the code to the target of a continue through the Switch host service (3.5): the repository lines in the handoff, a carry the user asked for, the dialog's plan, and a folder the target refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CHAT, code, connect, key, req, turns, world } from './support/hostServiceKit.ts';

const require = createRequire(import.meta.url);
const { createHostContinue } = require('../electron/host/hostContinue.cjs');
const { createCodeTransfer } = require('../electron/host/codeTransfer.cjs');

const HEAD = 'a'.repeat(40);
const repo = (over: object = {}) => ({ isRepo: true, remote: 'https://h.example/r.git', branch: 'main', head: HEAD, dirty: 0, ...over });

/** The service of `world()` with a code transfer over a scripted channel; `facts` answers `git.inspect` by Host. */
function withCode(
  facts: Record<string, any>,
  carry: Partial<Record<'plan' | 'push' | 'apply' | 'drop', any>> = {},
  folder: string | null = '/mac/app',
  harness = 'acp:gemini',
  /** What a scripted Host says instead of the real protocol, by method; undefined passes the call on. */
  say: (hostId: string, method: string, params: any) => Promise<any> | undefined = () => undefined,
) {
  const w = world();
  const calls: string[] = [];
  const code = createCodeTransfer({
    inspect: async (hostId: string, p: string) => {
      calls.push(`inspect:${hostId}:${p}`);
      const f = facts[hostId];
      if (f instanceof Error) throw f;
      return f ?? { isRepo: false };
    },
    clone: async () => ({ path: '/x', existed: false }),
    carry: {
      plan: carry.plan ?? (async () => ({ untracked: ['new.txt'], skipped: [], files: 2 })),
      push:
        carry.push ??
        (async () => ({ branch: 'mopilot/carry/key-0001', commit: HEAD, parent: HEAD, sourceBranch: 'main', skipped: ['.env'] })),
      apply: carry.apply ?? (async () => (calls.push('apply'), { files: 2 })),
      drop: carry.drop ?? (async () => void calls.push('drop')),
    },
    newKey: () => 'carry-key-0001',
    report: (p: string) => w.problems.push(p),
  });
  const service = createHostContinue({
    ownership: w.ownership,
    hostState: () => 'online',
    session: async (hostId: string, onEvent?: (e: any) => void) => {
      const conn = w.hosts[hostId].protocol.connection((m: object) => onEvent?.(m));
      return {
        call: (method: string, params: object) => {
          calls.push(`call:${hostId}:${method}`);
          return say(hostId, method, params) ?? conn.call(method, params);
        },
        close: () => conn.close(),
      };
    },
    local: w.local.channel,
    localTurns: async () => ({ turns, failed: [], label: 'Claude Code', model: null }),
    harnessOf: () => ({ harness, label: 'Chat agent' }),
    tails: w.tails,
    report: (p: string) => w.problems.push(p),
    newKey: () => `service-key-${Math.random().toString(16).slice(2, 10)}`,
    mirrorRev: () => 0,
    mirror: () => null,
    sleep: async () => undefined,
    code: { transfer: code, sourceFolder: async () => folder },
  });
  return { w, service, calls };
}
const firstText = async (w: ReturnType<typeof world>, host = 'B', epoch = 1) => {
  const { conn } = await connect(w.hosts[host]);
  await conn.call('chat.send', { chatId: CHAT, epoch, key: key(), text: 'go' });
  return w.hosts[host].sends[0].text as string;
};

test('3.5: the handoff names the repository and says how the folder on the target compares, with nothing carried unless asked', async () => {
  const { w, service, calls } = withCode({ local: repo({ dirty: 2 }), B: repo() });
  assert.deepEqual(await service.run(req()), { hostId: 'B', epoch: 1 });
  const text = await firstText(w);
  assert.match(text, /Repository: https:\/\/h\.example\/r\.git/);
  assert.match(text, /Branch: main at aaaaaaaaaaaa/);
  assert.match(text, /clone of that repository on that branch/);
  assert.match(text, /2 uncommitted files on the previous host were not carried over/);
  assert.ok(!calls.includes('apply'));
});

test('3.5: a carry the user asked for is sent before the chat moves, listed in the handoff, and its temporary branch is removed', async () => {
  const { w, service, calls } = withCode({ local: repo({ dirty: 2 }), B: repo() });
  assert.deepEqual(await service.run(req({ carry: { confirmed: true } })), { hostId: 'B', epoch: 1 });
  const text = await firstText(w);
  assert.match(text, /2 uncommitted files from the previous host were carried over/);
  assert.match(text, /Not carried over, because they look like secrets: \.env/);
  assert.deepEqual(
    calls.filter((c) => c === 'apply' || c === 'drop'),
    ['apply', 'drop'],
  );
});

test('M3: the unpushed commits the user agreed to reach the push, and none when the dialog says nothing', async () => {
  const pushes: any[] = [];
  const push = async (_h: string, r: any) => (
    pushes.push(r), { branch: 'mopilot/carry/key-0001', commit: HEAD, parent: HEAD, sourceBranch: 'main', skipped: [] }
  );
  await withCode({ local: repo({ dirty: 1 }), B: repo() }, { push }).service.run(
    req({ carry: { confirmed: true, untracked: [], unpushed: 3 } }),
  );
  await withCode({ local: repo({ dirty: 1 }), B: repo() }, { push }).service.run(req({ carry: { confirmed: true, untracked: [] } }));
  assert.deepEqual(
    pushes.map((p) => p.unpushed),
    [3, 0],
  );
});

test("3.5: new files the user did not confirm stop the continue with the carry's code, and nothing moves", async () => {
  const { w, service } = withCode({ local: repo({ dirty: 2 }), B: repo() });
  await assert.rejects(service.run(req({ carry: { confirmed: false, untracked: ['new.txt'] } })), code('carry_unconfirmed'));
  assert.equal(w.ownership.get(CHAT).ownerHostId, 'local');
  // a refusal from the target's apply reaches the dialog with its code, and the branch is still removed
  const refused = withCode(
    { local: repo({ dirty: 1 }), B: repo() },
    { apply: async () => Promise.reject(Object.assign(new Error('dirty'), { code: 'target_dirty' })) },
  );
  await assert.rejects(refused.service.run(req({ carry: { confirmed: true, untracked: [] } })), code('target_dirty'));
  assert.ok(refused.calls.includes('drop'));
  assert.equal(refused.w.ownership.get(CHAT).ownerHostId, 'local');
});

test("3.5: the dialog's plan before it asks: how the folder compares and what a carry would send; nothing when there is nothing to read", async () => {
  const { service } = withCode({ local: repo({ dirty: 2 }), B: repo({ branch: 'other' }) });
  assert.deepEqual(await service.codePlan(req()), {
    state: 'other_branch',
    repository: 'https://h.example/r.git',
    branch: 'main',
    dirty: 2,
    plan: { untracked: ['new.txt'], skipped: [], files: 2 },
  });
  const clean = withCode({ local: repo(), B: repo() });
  assert.equal((await clean.service.codePlan(req()))?.plan, null);
  const none = withCode({ local: { isRepo: false }, B: { isRepo: false } });
  assert.deepEqual(await none.service.codePlan(req()), { state: 'no_repository', repository: null, branch: null, dirty: 0, plan: null });
  const noFolder = withCode({}, {}, null);
  assert.equal(await noFolder.service.codePlan(req()), null);
  assert.equal(noFolder.calls.length, 0);
  const plain = world();
  assert.equal(await plain.service.codePlan(req()), null);
});

test('3.5: a folder the target refuses is refused now with its reason; a source that cannot be read still lets the continue go on', async () => {
  const missing = withCode({ local: repo(), B: Object.assign(new Error('No such folder.'), { code: 'directory_missing' }) });
  await assert.rejects(missing.service.run(req()), code('directory_missing'));
  assert.equal(missing.w.ownership.get(CHAT).ownerHostId, 'local');
  const unreadable = withCode({ local: new Error('git is gone'), B: repo() });
  assert.deepEqual(await unreadable.service.run(req()), { hostId: 'B', epoch: 1 });
  assert.ok(unreadable.w.problems.some((p) => /repository could not be read/.test(p)));
  assert.doesNotMatch(await firstText(unreadable.w), /Repository:/);
});

const status = (harnesses: object[]) => ({ harnesses, capabilities: {} });

test('A: #4910 the target is asked whether it can take the chat before anything is carried to it: a refusal at prepare leaves its folder untouched', async () => {
  // a Host that says it takes every family, whose Claude Code is signed out: the continue is refused as that, and no file reached its folder
  const out = withCode({ local: repo({ dirty: 2 }), B: repo() }, {}, '/mac/app', 'claude', (_h, method) =>
    method === 'host.status' ? Promise.resolve(status([{ id: 'claude', detected: true, signedIn: false, signIn: ['login'] }])) : undefined,
  );
  out.w.hosts.B.continueHost.takesFamilies = true;
  await assert.rejects(out.service.run(req({ carry: { confirmed: true, untracked: [] } })), code('agent_signed_out'));
  assert.ok(!out.calls.includes('apply'), 'no file was applied in the target folder');
  assert.ok(!out.calls.some((c) => c.endsWith('chat.prepareContinue')), 'the target was not even asked to prepare');
  assert.equal(out.w.ownership.get(CHAT).ownerHostId, 'local');
});

const answers = (rows: object[] | Error) => (_h: string, method: string) =>
  method === 'host.status' ? (rows instanceof Error ? Promise.reject(rows) : Promise.resolve(status(rows))) : undefined;
const carrying = req({ carry: { confirmed: true, untracked: [] } });
const run = (harness: string, rows: object[] | Error, families = true) => {
  const out = withCode({ local: repo({ dirty: 2 }), B: repo() }, {}, '/mac/app', harness, answers(rows));
  out.w.hosts.B.continueHost.takesFamilies = families;
  return out;
};

test('B: #4910 each fact refuses before the carry, for Claude Code, Codex and an ACP agent: not installed, signed out, and a Host too old for any but ACP', async () => {
  for (const [harness, id] of [
    ['claude', 'claude'],
    ['codex', 'codex'],
    ['acp:gemini', 'gemini'],
  ] as const) {
    const missing = run(harness, [{ id, detected: false, signedIn: false }]);
    await assert.rejects(missing.service.run(carrying), code('agent_missing'));
    const out = run(harness, [{ id, detected: true, signedIn: false }]);
    await assert.rejects(out.service.run(carrying), code('agent_signed_out'));
    for (const refused of [missing, out]) {
      assert.ok(!refused.calls.includes('apply') && !refused.calls.some((c) => c.endsWith('chat.prepareContinue')), harness);
      assert.equal(refused.w.ownership.get(CHAT).ownerHostId, 'local');
    }
  }
  // a Host that does not say `continueFamilies` takes ACP agents only: Claude Code and Codex are refused before any file moves, an ACP agent is not
  for (const harness of ['claude', 'codex']) {
    const old = run(harness, [{ id: harness, detected: true, signedIn: true }], false);
    await assert.rejects(old.service.run(carrying), code('harness_not_configured'));
    assert.ok(!old.calls.includes('apply'));
  }
  const acp = run('acp:gemini', [{ id: 'gemini', detected: true, signedIn: true }], false);
  assert.deepEqual(await acp.service.run(carrying), { hostId: 'B', epoch: 1 });
  assert.ok(acp.calls.includes('apply'));
});

test('I: #4910 what the status cannot show is left to the Host: a ready agent, an agent it does not list, a status that cannot be read, no carry asked for', async () => {
  // a signed-in agent, or one a lent key signs in, is carried to
  const ready = run('claude', [{ id: 'claude', detected: true, signedIn: true }]);
  await ready.service.run(carrying).catch(() => undefined);
  assert.ok(ready.calls.includes('apply'));
  const lent = run('claude', [{ id: 'claude', detected: true, signedIn: false, keyed: true }]);
  await lent.service.run(carrying).catch(() => undefined);
  assert.ok(lent.calls.includes('apply'), 'a key the app lends is a sign-in, as the Host reads it');
  // a key that merely exists on the Host is not this chat's: it is refused as signed out, before any file moves
  const exists = run('claude', [{ id: 'claude', detected: true, signedIn: false, sources: { key: true } }]);
  await assert.rejects(exists.service.run(carrying), code('agent_signed_out'));
  assert.ok(!exists.calls.includes('apply'));
  // the Host decides the agent its status does not list, and a status it cannot answer
  for (const rows of [[], new Error('away')]) {
    const out = run('claude', rows as any);
    await out.service.run(carrying).catch(() => undefined);
    assert.ok(out.calls.includes('apply'), 'the Host’s own prepare decides');
  }
  // without a carry nothing reaches the folder, so the status is not asked
  const plain = run('claude', [{ id: 'claude', detected: true, signedIn: false }]);
  await plain.service.run(req()).catch(() => undefined);
  assert.ok(!plain.calls.includes('call:B:host.status'));
});

test('B: a login the agent itself refused is its own refusal for the Mac, before the carry and at the press; a plain sign-out keeps its code', async () => {
  const before = run('claude', [{ id: 'claude', detected: true, signedIn: false, reason: 'login-refused' }]);
  await assert.rejects(before.service.run(carrying), code('agent_login_refused'));
  assert.ok(!before.calls.includes('apply'));
  const plain = run('claude', [{ id: 'claude', detected: true, signedIn: false }]);
  await assert.rejects(plain.service.run(carrying), code('agent_signed_out'));
  // a Host that says so only at prepare (no carry, so the status is never read)
  const prepareRefused = (details?: object) => (_h: string, method: string) =>
    method === 'chat.prepareContinue'
      ? Promise.reject(Object.assign(new Error('Sign in.'), { code: 'agent_signed_out', ...(details ? { details } : {}) }))
      : undefined;
  const press = withCode({ local: repo(), B: repo() }, {}, '/mac/app', 'acp:gemini', prepareRefused({ refused: true }));
  await assert.rejects(press.service.run(req()), code('agent_login_refused'));
  const signedOut = withCode({ local: repo(), B: repo() }, {}, '/mac/app', 'acp:gemini', prepareRefused());
  await assert.rejects(signedOut.service.run(req()), code('agent_signed_out'));
  assert.equal(press.w.ownership.get(CHAT).ownerHostId, 'local');
});
