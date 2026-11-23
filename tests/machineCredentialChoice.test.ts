// A machine chat's credential choice from start to wire (#4667): the Mac refuses a choice that is not there before any chat is made, keeps it with the chat's first message, and sends it to the Host; the phone's wire takes it for a machine and refuses it for a chat on this Mac; the phone reads what each agent will use and names it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { world as sendWorld, UUID, msg } from './support/host/remoteSendKit.ts';
import { hostWorld, onlineRemote } from './support/host-wire-kit.ts';
import { agentsOf } from '../shared/host/agentReadiness.mjs';
import { parseMachines, agentLine } from '../mobile/src/remote/machines.ts';
import { credentialChoices, credentialLine, sourceWords } from '../mobile/src/remote/credentialLine.ts';
import { createChatCredentials } from '../host/src/chatCredentials.mjs';
import { createCredentialLeases } from '../host/src/credentialLease.mjs';
import { reportedHarness } from '../host/src/harnessState.mjs';
import { normalizeHarness } from '../shared/host/logins.mjs';

const require = createRequire(import.meta.url);
const { createMachineChatStart } = require('../electron/host/machineChatStart.cjs');
const { rig } = require('./support/remote-kit.ts');
const S = require('../shared/remote/schema.mjs');
const HS = require('../shared/host/schema.mjs');

const tick = () => new Promise((r) => setImmediate(r));
const refusedWith = (code: string) => (e: any) => e.code === code;

function starter(o: { signedIn?: boolean; keys?: boolean; org?: boolean; takes?: boolean; unsure?: boolean } = {}) {
  const begun: any[] = [];
  const machine = {
    name: 'box',
    harnesses: [
      {
        id: 'claude',
        detected: true,
        signedIn: o.signedIn ?? true,
        takesKey: o.takes ?? true,
        takesOrg: o.takes ?? true,
        ...(o.unsure ? { unsure: true } : {}),
      },
    ],
  };
  const chats = createMachineChatStart({
    row: () => machine,
    apiKeys: { hasFor: () => o.keys === true },
    orgAccess: { covers: () => o.org === true },
    bind: () => undefined,
    begin: (chatId: string, start: any) => begun.push([chatId, start]),
    follow: () => Promise.resolve(),
  });
  const q = (credential?: any) => ({
    chatId: 'acp:host-claude:1',
    hostId: 'h',
    folder: '/srv',
    harness: 'claude',
    projectId: null,
    credential,
  });
  return { chats, begun, q };
}

test('the Mac checks a chosen credential against what exists before a chat is made, and keeps the choice with the first message', async () => {
  const w = starter({ keys: true, org: true });
  for (const credential of [{ source: 'own' }, { source: 'key' }, { source: 'org' }])
    await w.chats.start(w.q(credential), { background: true });
  assert.deepEqual(
    w.begun.map(([, s]) => s.credential.source),
    ['own', 'key', 'org'],
  );
  const none = starter();
  await none.chats.start(none.q(), { background: false });
  assert.equal('credential' in none.begun[0][1], false, 'a start that chose nothing is as before');
  const signedOut = starter({ signedIn: false });
  await assert.rejects(signedOut.chats.start(signedOut.q({ source: 'own' })), refusedWith('login_signed_out'));
  await assert.rejects(starter({ keys: false }).chats.start(starter().q({ source: 'key' })), refusedWith('credential_unavailable'));
  const nokey = starter({ keys: false });
  await assert.rejects(nokey.chats.start(nokey.q({ source: 'key' })), /key from your Mac/);
  const noorg = starter({ org: false });
  await assert.rejects(noorg.chats.start(noorg.q({ source: 'org' })), /organization's access/);
  const unable = starter({ keys: true, org: true, takes: false });
  await assert.rejects(unable.chats.start(unable.q({ source: 'key' })), refusedWith('credential_unavailable'));
  await assert.rejects(unable.chats.start(unable.q({ source: 'org' })), refusedWith('credential_unavailable'));
  assert.deepEqual([nokey.begun, noorg.begun, signedOut.begun], [[], [], []], 'a refused start makes nothing');
});

test('the first message of a chat that chose carries the choice to the Host; a later one does not', async (t) => {
  const w = sendWorld(t);
  w.remote('c1');
  w.service.begin('c1', { harness: 'claude', projectId: null, credential: { source: 'key' } });
  w.service.enqueue('c1', msg('go', UUID(1)), 1, Promise.resolve());
  await tick();
  assert.deepEqual(w.started[0].item.credential, { source: 'key' });
  w.remote('c2');
  w.service.begin('c2', { harness: 'claude', projectId: null });
  w.service.enqueue('c2', msg('go', UUID(2)), 1, Promise.resolve());
  await tick();
  assert.equal('credential' in w.started[1].item, false);
});

test('the Host wire carries the choice on chat.start, and the gate refuses a Host without the feature', () => {
  const start = { chatId: 'claude:abc', epoch: 1, key: 'req-0000001', harness: 'claude', text: 'go', projectId: null };
  assert.deepEqual(HS.parseParams('chat.start', { ...start, credential: { source: 'own' } }).credential, { source: 'own' });
  assert.throws(
    () => HS.requireFeatures('chat.start', { features: ['epoch', 'dedupe', 'isolation'] }, { credential: { source: 'own' } }),
    /logins/,
  );
});

test('the phone’s chat.start takes a choice for a machine and refuses it for a chat on this Mac', async () => {
  const start = { harness: 'claude', text: 'go', hostId: 'h1', folder: '/srv' };
  assert.deepEqual(S.parseParams('chat.start', { ...start, credential: { source: 'key' } }).credential, { source: 'key' });
  assert.equal('credential' in S.parseParams('chat.start', start), false);
  assert.throws(() => S.parseParams('chat.start', { ...start, credential: { source: 'cloud' } }));
  const r = rig({ ops: { usable: async () => true, start: async () => ({ chatId: 'c' }) } });
  const p = r.phone('p1');
  const answer = await p.ask('chat.start', { harness: 'claude', text: 'go', credential: { source: 'key' } });
  assert.equal(answer.ok, false);
  assert.match(answer.error.message, /Only a chat on a machine/);
});

test('the phone’s chat.switch takes the choice for the agent the chat moves to, and leaves it out when there is none', () => {
  const sw = { chatId: 'acp:kimi:c1', harness: 'claude' };
  assert.deepEqual(S.parseParams('chat.switch', { ...sw, credential: { source: 'own', login: 'work' } }).credential, {
    source: 'own',
    login: 'work',
  });
  assert.equal('credential' in S.parseParams('chat.switch', sw), false);
  assert.equal('credential' in S.parseParams('chat.switch', { ...sw, credential: null }), false);
  assert.throws(() => S.parseParams('chat.switch', { ...sw, credential: { source: 'cloud' } }));
});

test('a machine’s agent row carries what a chat will use and what exists, and the phone reads it', () => {
  const rows = agentsOf(
    [
      { id: 'claude', detected: true, signedIn: true, using: 'key', sources: { own: true, key: true, org: false } },
      { id: 'gemini', detected: true, signedIn: true, loginsSupported: false },
      { id: 'codex', detected: true, signedIn: false },
    ],
    'box',
  );
  assert.deepEqual(
    [rows[0].using, rows[0].sources, rows[1].loginsSupported, 'using' in rows[2]],
    ['key', { own: true, key: true, org: false }, false, false],
  );
  const [m] = parseMachines({
    machines: [
      {
        id: 'h',
        line: 'Online',
        agents: [
          { id: 'claude', state: 'ready', via: 'own', using: 'key', sources: { own: true, key: true, org: 0 } },
          { id: 'gemini', state: 'ready', via: 'own', loginsSupported: false },
          { id: 'odd', state: 'ready', using: 'cloud', sources: 'all', loginsSupported: 'no' },
        ],
      },
    ],
  });
  const [claude, gemini, odd] = m.agents;
  assert.deepEqual([claude.using, claude.sources], ['key', { own: true, key: true, org: false }]);
  assert.equal(gemini.loginsSupported, false);
  assert.deepEqual([odd.using, odd.sources, odd.loginsSupported], [undefined, undefined, undefined]);
});

test('the line names what a chat will use, whatever the order; a Host that says nothing claims nothing; a choice is offered only when there is one', () => {
  assert.equal(sourceWords('own', 'Studio'), 'Signed in on Studio');
  assert.equal(sourceWords('key', 'Studio'), "Your Mac's key · pay per use");
  assert.equal(sourceWords('org', 'Studio'), "Your organization's access");
  assert.equal(credentialLine({ using: 'key' }, 'Studio'), "Your Mac's key · pay per use");
  assert.equal(credentialLine({}, 'Studio'), null);
  assert.equal(credentialLine(null, 'Studio'), null);
  const both = { using: 'key' as const, sources: { own: true, key: true, org: false } };
  assert.deepEqual(
    credentialChoices(both, 'Studio').map((c) => [c.source, c.inUse]),
    [
      ['own', false],
      ['key', true],
    ],
  );
  assert.deepEqual(credentialChoices({ using: 'own' as const, sources: { own: true, key: false, org: false } }, 'Studio'), []);
  assert.deepEqual(credentialChoices({}, 'Studio'), []);
  assert.deepEqual(credentialChoices(undefined, 'Studio'), []);
  // the machine page row says it too, and the old guess is used only when the Host says nothing
  const agent = { id: 'claude', label: 'Claude Code', state: 'ready' as const, via: 'own' as const };
  assert.equal(agentLine({ ...agent, using: 'key' }, 'Studio'), "Your Mac's key · pay per use");
  assert.equal(agentLine(agent), 'Ready');
});

test('the Mac’s start on a Host sends the choice as chat.start’s credential; one that chose nothing sends none', async (t) => {
  const w = hostWorld(t);
  const { features } = (w.net.handlers['host.hello'] as any)();
  // a Host that enforces the choice declares `logins`: the Mac sends it one; without it the Mac refuses to
  const without = await onlineRemote(w, {}, { epochOf: () => 2 });
  await assert.rejects(
    without.host.start('acp:kimi:c', { harness: 'acp:kimi', text: 'go', credential: { source: 'own' } }),
    /lacks logins/,
  );
  w.net.handlers['host.hello'] = () => ({ protocol: { minor: 1, floor: 1 }, features: [...features, 'logins'] });
  const { host } = await onlineRemote(w, {}, { epochOf: () => 2 });
  const seen: any[] = [];
  w.net.handlers['chat.start'] = (p: any) => (seen.push(p), { replayed: false, result: {} });
  await host.start('acp:kimi:c', { harness: 'acp:kimi', text: 'go', credential: { source: 'own' } });
  await host.start('acp:kimi:d', { harness: 'acp:kimi', text: 'go' });
  assert.deepEqual(seen[0].credential, { source: 'own' });
  assert.equal('credential' in seen[1], false);
});

test('with the machine’s own login first, the line names it for Claude Code and Codex and the lent key for an agent whose one process takes it', async () => {
  // a Host signed in to three agents, with a key lent to each: what it reports is what the phone says, nothing more
  const leases = createCredentialLeases();
  leases.set('claude', 'sk-ant-dummy-0000-test-key-abcd');
  leases.set('gemini', 'sk-gemini-dummy-0000-test-key-abcd');
  leases.set('codex', 'sk-proj-dummy-0000-test-key-abcd');
  const credentials = createChatCredentials({ leases });
  const io = { codex: { models: async () => [] }, sessions: { modelsOf: () => [] }, leases, credentials };
  const line = async (id: string) => {
    const reported = normalizeHarness(await reportedHarness({ id, detected: true, signedIn: true }, io));
    return credentialLine({ using: reported.using }, 'Studio');
  };
  assert.equal(await line('claude'), 'Signed in on Studio', 'Claude Code: the subscription, though a key is lent');
  assert.equal(
    await line('codex'),
    'Signed in on Studio',
    'Codex: a process for each credential (H3), so the subscription, though a key is lent',
  );
  assert.equal(
    await line('gemini'),
    "Your Mac's key · pay per use",
    'a basic agent: its one process uses the lent key, and the line does not claim otherwise',
  );
  // nothing usable on the machine: the lent key
  const out = normalizeHarness(await reportedHarness({ id: 'claude', detected: true, signedIn: false }, io));
  assert.equal(credentialLine({ using: out.using }, 'Studio'), "Your Mac's key · pay per use");
});

test('an agent the Host could not check still starts a chat, with or without the machine’s own login chosen (#5177); a signed-out one does not', async () => {
  const unsure = starter({ signedIn: false, unsure: true });
  await unsure.chats.start(unsure.q(), { background: true });
  const own = starter({ signedIn: false, unsure: true });
  await own.chats.start(own.q({ source: 'own' }), { background: true });
  assert.equal(unsure.begun.length + own.begun.length, 2);
  // a lendable key still wins: that chat is lent, not the machine's own
  const keyed = starter({ signedIn: false, unsure: true, keys: true });
  assert.equal((await keyed.chats.start(keyed.q(), { background: true })).by, 'lent');
  const out = starter({ signedIn: false });
  await assert.rejects(out.chats.start(out.q()), refusedWith('harness_not_configured'));
});
