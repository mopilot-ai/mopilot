// A chat's `steer` capability (electron/harness/bindings.cjs, resolved by electron/session/caps.cjs) says what main does
// with a steer request: native exactly where main takes a message into the running turn, for a chat of this Mac by its
// family (controllerSends.cjs) and for a chat on a machine by the agent its Host runs (remotePicks.cjs `steersInto`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mainCapsFor, type ChatPlace } from './support/steer-caps.ts';

const require = createRequire(import.meta.url);
const { traitsOf } = require('../electron/harness/family.cjs');
const { steersInto } = require('../electron/host/remotePicks.cjs');
const { kindOfChat } = require('../electron/host/wiring.cjs');

/** What main does with a steer request for the chat: This Mac's send path, or the Host's for a chat its remote route owns. */
function mainSteers(kind: string, { onMachine = false, hostAgent }: ChatPlace) {
  if (!onMachine) return traitsOf(kind).steers;
  const live = {
    chats: { get: () => ({ meta: { config: hostAgent === undefined ? {} : { hostAgent } } }) },
    controller: { ref: () => ({ kind }) },
  };
  return steersInto({ item: { followUp: 'steer' }, kind: kindOfChat(live, 'c1'), opts: {}, held: null });
}

const machine = (hostAgent?: unknown): ChatPlace => ({ onMachine: true, hostAgent });
for (const [chat, kind, place, steers] of [
  ['Codex', 'codex', {}, true],
  ['Claude Code', 'claude', {}, true],
  ['local ACP', 'acp:opencode', {}, false],
  ["a machine's Claude Code chat", 'acp:host-claude', machine(), true],
  ["a machine's Codex chat", 'acp:host-codex', machine(), true],
  ["a machine's basic-agent chat", 'acp:kimi', machine(), false],
  ["a machine's Claude Code chat its Host switched to Codex", 'acp:host-claude', machine('codex'), true],
  ["a machine's Codex chat its Host switched to Claude Code", 'acp:host-codex', machine('claude'), true],
  ["a machine's Claude Code chat its Host switched to a basic agent", 'acp:host-claude', machine('acp:kimi'), false],
  ["a machine's basic-agent chat its Host switched to Codex", 'acp:kimi', machine('codex'), true],
  ['a Codex chat continued onto a machine on a basic agent', 'codex', machine('acp:gemini'), false],
  ['a Codex chat continued back to this Mac, its old Host agent still kept', 'codex', { hostAgent: 'acp:gemini' }, true],
  ['an ACP chat continued back to this Mac from Claude Code on a machine', 'acp:gemini', { hostAgent: 'claude' }, false],
  ["a machine's Claude Code chat while this Mac has no route to it", 'acp:host-claude', {}, false],
  ["a machine's chat whose Host named no agent it keeps", 'acp:host-codex', machine(null), true],
  ["a machine's chat whose Host named an agent this build doesn't know", 'acp:host-claude', machine('gemini'), false],
  ["a machine's chat whose kept agent is no kind", 'acp:host-claude', machine(42), false],
] as const) {
  test(`${chat}: steer is ${steers ? 'native' : 'absent'}, as main takes a steer request for it`, async () => {
    const caps = await mainCapsFor(kind, place);
    assert.equal(caps.tier, kind === 'codex' || kind === 'claude' ? 'first' : 'basic');
    assert.equal(caps.caps.steer.state, steers ? 'native' : 'absent');
    if (!steers) assert.deepEqual(caps.caps.steer.why, { layer: 'harness', code: 'harness.noSteer' });
    assert.equal(mainSteers(kind, place), steers, 'the capability and the send path agree');
  });
}

test("another app running the chat's turn turns steer off with the session's reason, for a machine's chat too", async () => {
  for (const [kind, place] of [
    ['codex', {}],
    ['acp:host-claude', machine()],
  ] as const) {
    const caps = await mainCapsFor(kind, place, { turn: 'running', runningElsewhere: true, acp: null });
    assert.equal(caps.caps.steer.state, 'disabled', kind);
    assert.deepEqual(caps.caps.steer.why, { layer: 'session', code: 'session.runningElsewhere', fix: 'wait' });
  }
});

test('a chat that has not started is asked for by its harness alone: no machine is asked about it', async () => {
  const { CapsService } = require('../electron/session/caps.cjs');
  const asked: unknown[] = [];
  const service = new CapsService({
    ref: () => null,
    onMachine: (id: unknown) => (asked.push(id), true),
    record: () => null,
    session: () => null,
    isEnabled: () => true,
    codex: async () => ({ version: '0.162.0', models: [], negotiated: { probes: {}, flags: {} } }),
    claude: { version: () => '2.1.295', probeInfo: () => ({ models: [], fastBlocked: null }), appliedOf: () => null },
    instances: () => [],
    prefs: () => ({}),
  });
  assert.equal((await service.get(null, { kind: 'claude' })).caps.steer.state, 'native');
  assert.equal((await service.get(null, { kind: 'acp:kimi' })).caps.steer.state, 'absent');
  assert.deepEqual(asked, []);
});
