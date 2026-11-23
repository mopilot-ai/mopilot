// The dev host's made-up machines (scripts/mobile-dev-host/fakeHosts.mjs, --fake-hosts), served by the real remote service: this Mac and two machines in the Mac's own words, folders, a chat started on a machine (Claude Code, Codex, an ACP agent), Switch host with the Mac's refusals, and machines.changed when one comes and goes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, settle } from './support/remote-kit.ts';
import { createFakeApp } from '../scripts/mobile-dev-host/fakeApp.mjs';
import { createFakeHosts } from '../scripts/mobile-dev-host/fakeHosts.mjs';
import { createControls } from '../scripts/mobile-dev-host/controls.mjs';

const ok = (r: any) => (assert.equal(r.ok, true, JSON.stringify(r.error)), r.result);
const fail = (r: any, code: string, message?: RegExp) => {
  assert.equal(r.ok, false, JSON.stringify(r.result));
  assert.equal(r.error.code, code, r.error.message);
  if (message) assert.match(r.error.message, message);
};
const NOW = 10 * 86_400_000;

function world() {
  const logs: string[] = [];
  const app = createFakeApp({
    repo: '/repo',
    log: (l: string) => logs.push(l),
    now: () => NOW,
    sleep: async () => undefined,
    status: async () => '',
  });
  const hosts = createFakeHosts({ app, log: (l: string) => logs.push(l), now: () => 1000 });
  const r = rig({ ops: app.ops, host: () => hosts, machineName: () => 'Dev Mac' });
  app.bind(r.service);
  return { app, hosts, r, p: r.phone('p1'), logs };
}

test('machines.list: this Mac, an online machine with a ready, a signed-out and a key agent, and an offline one', async () => {
  const { p } = world();
  assert.equal(ok(await p.ask('machine.hello')).capabilities.machines, true);
  const { machines } = ok(await p.ask('machines.list'));
  assert.deepEqual(
    machines.map((m: any) => [m.id, m.status, m.line, m.tone, m.path]),
    [
      ['local', 'online', 'Online · Codex, Claude Code', 'ok', 'direct'],
      ['ssh:studio', 'online', 'Online · Claude Code, Gemini', 'ok', 'relay'],
      ['ssh:old-mini', 'offline', 'Offline · No answer · seen 2 h ago', 'off', 'direct'],
    ],
  );
  assert.deepEqual(machines[1].agents, [
    { id: 'claude', label: 'Claude Code', state: 'ready', via: 'own' },
    // the machine's own words for a signed-out agent ride on the row, so the phone says where to sign in (#4861)
    { id: 'codex', label: 'Codex', state: 'signin', via: null, reason: 'Sign in on studio' },
    { id: 'gemini', label: 'Gemini', state: 'ready', via: 'key' },
  ]);
});

test('folders on a machine that answers; one that is away or unknown is refused with the Mac’s codes', async () => {
  const { p } = world();
  const listing = ok(await p.ask('machines.folders', { id: 'ssh:studio' }));
  assert.deepEqual(
    listing.entries.map((e: any) => [e.name, e.git]),
    [
      ['mopilot', true],
      ['website', true],
      ['notes', false],
    ],
  );
  assert.equal(
    ok(await p.ask('machines.folders', { id: 'ssh:studio', path: '/Users/dev/mopilot' })).entries[0].path,
    '/Users/dev/mopilot/mopilot',
  );
  // an away machine is `offline` (the short refusal the Mac gives), a folder outside what it shares or a missing one has its own code
  fail(await p.ask('machines.folders', { id: 'ssh:old-mini' }), 'offline', /isn't reachable/);
  fail(await p.ask('machines.folders', { id: 'ssh:nowhere' }), 'unknown_machine');
  fail(await p.ask('machines.folders', { id: 'ssh:studio', path: '/etc' }), 'outside_roots');
  fail(await p.ask('machines.folders', { id: 'ssh:studio', path: '/Users/dev/nowhere' }), 'directory_missing');
});

test('a chat started on a machine for each harness: listed with its machine, refused where the agent can’t run, the folder checked first, an away machine refused', async () => {
  const { p, logs } = world();
  const start = (o: object) => p.ask('chat.start', { text: 'build it', folder: '/Users/dev/mopilot', ...o });
  const claude = ok(await start({ harness: 'claude', hostId: 'ssh:studio' }));
  const gemini = ok(await start({ harness: 'acp:gemini', hostId: 'ssh:studio' }));
  fail(await start({ harness: 'codex', hostId: 'ssh:studio' }), 'harness_not_configured', /Sign in to Codex on studio/);
  fail(await start({ harness: 'acp:kimi', hostId: 'ssh:studio' }), 'harness_not_configured', /isn't installed on studio/);
  fail(await start({ harness: 'claude', hostId: 'ssh:nowhere' }), 'unknown_machine');
  // the folder is read first: outside what the machine shares or missing is refused with its code, and nothing is made
  fail(await start({ harness: 'claude', hostId: 'ssh:studio', folder: '/etc' }), 'outside_roots');
  fail(await start({ harness: 'claude', hostId: 'ssh:studio', folder: '/Users/dev/nowhere' }), 'directory_missing');
  // an away machine is refused with the short `offline` reason, not queued
  fail(await start({ harness: 'claude', hostId: 'ssh:old-mini' }), 'offline', /isn't reachable/);
  await settle();
  const { chats } = ok(await p.ask('chats.recent', { limit: 50 }));
  const on = (id: string) => chats.find((c: any) => c.id === id)?.hostId;
  assert.deepEqual([on(claude.chatId), on(gemini.chatId)], ['ssh:studio', 'ssh:studio']);
  assert.ok(chats.filter((c: any) => c.hostId === null).length > 0, 'the other chats run on this Mac');
  assert.ok(logs.some((l) => l.includes('started on studio')));
});

test('Switch host: the Mac’s refusals, then a move that lands; the old mini comes online and the phone hears it', async () => {
  const { p, r, hosts, app } = world();
  const seeded = [...app.chats.keys()][0];
  const other = [...app.chats.keys()][1];
  const clean = [...app.chats.keys()][2];
  const move = (o: object) => p.ask('chat.move', { chatId: other, folder: '/Users/dev/mopilot', carry: 'none', ...o });
  fail(await p.ask('chat.move', { chatId: seeded, hostId: 'ssh:studio', folder: '/Users/dev/mopilot', carry: 'none' }), 'same_host');
  fail(await move({ hostId: 'ssh:old-mini' }), 'target_offline', /isn't reachable/);
  fail(await move({ hostId: 'ssh:studio', carry: 'code' }), 'carry_unconfirmed');
  fail(await move({ hostId: 'ssh:nowhere' }), 'unknown_machine');
  fail(await move({ hostId: 'ssh:studio', folder: '/etc' }), 'outside_roots');
  fail(await move({ hostId: 'ssh:studio', folder: '/Users/dev/nowhere' }), 'directory_missing');
  // a chat with nothing to confirm moves with its changes; back to this Mac goes only into a saved project
  assert.deepEqual(ok(await p.ask('chat.move', { chatId: clean, hostId: 'ssh:studio', folder: '/Users/dev/website', carry: 'code' })), {
    chatId: clean,
  });
  assert.equal(hosts.hostOf(clean), 'ssh:studio');
  fail(await p.ask('chat.move', { chatId: clean, hostId: 'local', folder: '/Users/dev/website', carry: 'none' }), 'outside_roots');
  assert.deepEqual(ok(await p.ask('chat.move', { chatId: clean, hostId: 'local', folder: '/Users/dev/mopilot', carry: 'none' })), {
    chatId: clean,
  });
  assert.equal(hosts.hostOf(clean), 'local');
  fail(await p.ask('chat.move', { chatId: clean, hostId: 'local', folder: '/Users/dev/mopilot', carry: 'none' }), 'same_host');
  // by the project's id, as the phone names it: out to the machine and back; an unknown id is refused
  ok(await p.ask('chat.move', { chatId: clean, hostId: 'ssh:studio', folder: '/Users/dev/website', carry: 'none' }));
  fail(await p.ask('chat.move', { chatId: clean, hostId: 'local', projectId: 'nope', carry: 'none' }), 'unknown_project');
  // a chat that was never moved is already on this Mac
  const never = [...app.chats.keys()][3];
  fail(await p.ask('chat.move', { chatId: never, hostId: 'local', projectId: 'dev-repo', carry: 'none' }), 'same_host');
  assert.deepEqual(ok(await p.ask('chat.move', { chatId: clean, hostId: 'local', projectId: 'dev-repo', carry: 'none' })), {
    chatId: clean,
  });
  assert.equal(hosts.hostOf(clean), 'local');
  fail(await p.ask('chat.move', { chatId: clean, hostId: 'local', projectId: 'dev-repo', carry: 'none' }), 'same_host');
  assert.deepEqual(ok(await move({ hostId: 'ssh:studio' })), { chatId: other });
  assert.equal(hosts.hostOf(other), 'ssh:studio');
  // the bench flips the old mini, and every phone allowed the list is told
  const logs: string[] = [];
  const controls = createControls({
    bench: { momo: false, brain: false },
    log: (l: string) => logs.push(l),
    hosts: { toggle: () => hosts.toggle(), changed: () => r.service.onMachinesChanged() },
  } as any);
  assert.match(controls.hosts(), /old-mini is online/);
  await settle();
  const told = p.events('machines.changed').at(-1);
  assert.equal(told.machines.find((m: any) => m.id === 'ssh:old-mini').status, 'online');
  assert.equal(ok(await p.ask('machines.folders', { id: 'ssh:old-mini' })).entries.length, 3);
  assert.match(controls.hosts(), /old-mini is offline/);
  // without --fake-hosts the bench says how to get machines
  assert.throws(
    () => (createControls({ bench: { momo: false, brain: false }, log: () => undefined } as any) as any).hosts(),
    /--fake-hosts/,
  );
});

test('a phone removed while the folder was read starts and moves nothing: the facade calls check after its reads', async () => {
  const { hosts, app } = world();
  const seeded = app.chats.size;
  const stop = () => {
    throw new Error('This device is no longer paired.');
  };
  const [, , clean] = [...app.chats.keys()];
  await assert.rejects(
    hosts.start({ hostId: 'ssh:studio', folder: '/Users/dev/mopilot', harness: 'claude', projectId: null, text: 'x', check: stop }),
    /no longer paired/,
  );
  await assert.rejects(
    hosts.move({ chatId: clean, hostId: 'ssh:studio', folder: '/Users/dev/mopilot', carry: 'none', check: stop }),
    /no longer paired/,
  );
  assert.equal(hosts.hostOf(clean), 'local');
  assert.equal(app.chats.size, seeded, 'no chat was made');
});

test('the registry records the facade reads: a machine’s record, none for an unknown one; no organization lease', () => {
  const { hosts } = world();
  assert.equal(hosts.record('ssh:studio').name, 'studio');
  assert.equal(hosts.record('ssh:nowhere'), null);
  assert.equal(hosts.orgCovers(), false);
});

test("agent sets one agent missing, signed out or ready on a made-up machine: the rows say it in the Host's words and a start is refused to match", async () => {
  const { hosts, p } = world();
  const agentsOf = async () => ok(await p.ask('machines.list', {})).machines.find((m: any) => m.id === 'ssh:studio').agents;
  const codex = async () => (await agentsOf()).find((a: any) => a.id === 'codex');
  const start = (harness: string) => p.ask('chat.start', { text: 'go', folder: '/Users/dev/mopilot', harness, hostId: 'ssh:studio' });
  assert.deepEqual([(await codex()).state, (await codex()).reason], ['signin', 'Sign in on studio']);
  hosts.setAgent('studio', 'codex', 'missing');
  assert.deepEqual([(await codex()).state, (await codex()).reason], ['missing', 'Not installed on studio']);
  fail(await start('codex'), 'harness_not_configured', /isn't installed on studio/);
  hosts.setAgent('studio', 'claude', 'signin');
  assert.equal((await agentsOf()).find((a: any) => a.id === 'claude').reason, 'Sign in on studio');
  fail(await start('claude'), 'harness_not_configured', /Sign in to Claude on studio/);
  hosts.setAgent('studio', 'codex', 'ready');
  assert.deepEqual([(await codex()).state, (await codex()).reason ?? ''], ['ready', '']);
  ok(await start('codex'));
  hosts.setAgent('old-mini', 'claude', 'signin');
  assert.throws(() => hosts.setAgent('nowhere', 'claude', 'ready'), /No made-up machine "nowhere"\. Try: studio, old-mini/);
  assert.throws(() => hosts.setAgent('studio', 'kimi', 'ready'), /No agent "kimi"\. Try: claude, codex, gemini/);
  assert.throws(() => hosts.setAgent('studio', 'codex', 'broken'), /State is ready, missing or signin/);
});

test('the bench agent command sets the agent and tells every phone; without --fake-hosts it says how to get machines', async () => {
  const { hosts, r } = world();
  let told = 0;
  const controls = createControls({
    bench: { momo: false, brain: false },
    log: () => undefined,
    hosts: { setAgent: (m: string, a: string, s: string) => hosts.setAgent(m, a, s), changed: () => void told++ },
  } as any);
  assert.match(controls.agent('studio', 'codex', 'missing'), /codex on studio is missing/);
  assert.equal(told, 1);
  void r;
  assert.throws(
    () => (createControls({ bench: { momo: false, brain: false }, log: () => undefined } as any) as any).agent('studio', 'codex', 'ready'),
    /--fake-hosts/,
  );
});
