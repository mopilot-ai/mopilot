// "Move to another computer" for a chat's agent (#4909): a machine that cannot take Claude Code, Codex or an ACP agent says why before the press, a refusal is said by the fact that holds (never the raw "no claude agent set up", never one sentence for three causes), and an older Host or Mac keeps working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, click, createElement, createRoot, flush } from './support/phone/component-kit';

const agentsPath = '../mobile/src/remote/moveAgents';
const sheetPath = '../mobile/src/components/MoveSheet';
const headerPath = '../mobile/src/components/ChatHeader';
const linkPath = '../mobile/src/macLink';
const { agentIdOf, cannotTake, moveRefusal, refusalCode, refusalCopy } = await import(agentsPath);
const { MoveSheet } = await import(sheetPath);
const { ChatHeader } = await import(headerPath);
const { MacLinkProvider } = await import(linkPath);

const CLAUDE = { id: 'claude', label: 'Claude Code' };
const CODEX = { id: 'codex', label: 'Codex' };
const KIMI = { id: 'acp:kimi', label: 'Kimi' };

const row = (id: string, state: 'ready' | 'signin' | 'missing', reason?: string) => ({
  id,
  label: id,
  state,
  via: null,
  ...(reason ? { reason } : {}),
});
const machine = (id: string, name: string, agents: any[] = [], status = 'online') => ({
  id,
  name,
  status,
  line: 'Online',
  tone: 'ok',
  keepRunning: null,
  agents,
});

test('a chat’s agent is named the way the machine names it: built-in agents by id, ACP agents without the prefix, a Host chat by its family', () => {
  assert.deepEqual(['claude', 'codex', 'acp:kimi', 'acp:host-claude', 'acp:host-codex', ' kimi ', '', undefined].map(agentIdOf), [
    'claude',
    'codex',
    'kimi',
    'claude',
    'codex',
    'kimi',
    null,
    null,
  ]);
});

test('before the press: not installed and signed out are said for Claude Code, Codex and an ACP agent; ready, unknown or unreported say nothing', () => {
  const box = (state: any, id: string, reason?: string) => machine('h1', 'Studio', [row(id, state, reason)]);
  for (const [agent, label] of [
    [CLAUDE, 'Claude Code'],
    [CODEX, 'Codex'],
    [KIMI, 'Kimi'],
  ] as const) {
    const id = agentIdOf(agent.id)!;
    assert.equal(cannotTake(box('missing', id), agent), `${label} isn't installed on Studio.`);
    assert.equal(
      cannotTake(box('signin', id), agent),
      `Sign in to ${label} on Studio.`,
      'signed out with no words from the Host: the shared sentence',
    );
    assert.equal(
      cannotTake(box('signin', id, 'Sign in on Studio: work, home'), agent),
      'Sign in on Studio: work, home',
      'signed out with the Host’s own words (the logins to use): shown as given',
    );
    assert.equal(cannotTake(box('ready', id), agent), null);
  }
  // nothing says it cannot: this Mac, an offline machine, a machine that lists no row for the agent or no agents at all (an older Mac), no agent known
  assert.equal(cannotTake(machine('local', 'This Mac', [row('claude', 'missing')]), CLAUDE), null);
  assert.equal(cannotTake(machine('h1', 'Studio', [row('claude', 'missing')], 'offline'), CLAUDE), null);
  assert.equal(cannotTake(machine('h1', 'Studio', [row('codex', 'ready')]), CLAUDE), null);
  assert.equal(cannotTake(machine('h1', 'Studio'), CLAUDE), null);
  assert.equal(cannotTake(machine('h1', 'Studio', [row('claude', 'missing')]), null), null);
  assert.equal(cannotTake(machine('h1', 'Studio', [row('claude', 'missing')]), { id: '', label: 'x' }), null);
});

test('after a refusal: each code says its own fact in the machine’s and the agent’s name, whether the code is on the error or on its cause; any other failure is left to the Mac’s words', () => {
  const coded = (code: string, message = 'raw') => Object.assign(new Error(message), { code });
  const said = (code: string) => moveRefusal(coded(code, 'This host has no claude agent set up.'), 'Studio', 'Claude Code');
  assert.equal(said('agent_missing'), "Claude Code isn't installed on Studio.");
  assert.equal(said('agent_signed_out'), 'Sign in to Claude Code on Studio.');
  assert.equal(said('harness_not_configured'), 'Studio is too old to take this chat. Update it.');
  assert.equal(said('agent_login_refused'), "Claude Code's login on Studio is refused. Sign in again.");
  assert.equal(
    new Set(['agent_missing', 'agent_signed_out', 'harness_not_configured', 'agent_login_refused'].map(said)).size,
    4,
    'four facts, four sentences',
  );
  // a request bound to the screen keeps the original as the cause
  assert.equal(moveRefusal(new Error('x', { cause: coded('agent_missing') }), 'Studio', 'Codex'), "Codex isn't installed on Studio.");
  assert.equal(moveRefusal(coded('agent_missing'), 'Studio', undefined), "This agent isn't installed on Studio.");
  for (const other of [
    coded('turn_running'),
    coded('Constructor'),
    coded('toString'),
    new Error('The folder is on another branch.'),
    'text',
    null,
    undefined,
  ])
    assert.equal(moveRefusal(other, 'Studio', 'Codex'), null);
  assert.equal(refusalCode({ cause: { code: 3 }, code: 'a' }), undefined, 'a code that is not text is no code');
  assert.equal(refusalCopy(undefined, 'Studio', 'Codex'), null);
});

async function mount(node: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  await flush();
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
const LISTING = { path: '/srv', roots: ['/srv'], entries: [{ name: 'shop', path: '/srv/shop', git: true }], more: false };
function rig(move?: () => never) {
  const calls: [string, any][] = [];
  const request = async (method: string, params: any = {}) => {
    calls.push([method, params]);
    if (method === 'machines.folders') return LISTING;
    if (method === 'chat.move') return move?.();
    return {};
  };
  return { request, calls };
}
const MACHINES = [
  machine('local', 'This Mac'),
  machine('ready', 'Ready box', [row('claude', 'ready'), row('codex', 'ready'), row('kimi', 'ready')]),
  machine('gone', 'Empty box', [row('claude', 'missing'), row('codex', 'missing'), row('kimi', 'missing')]),
  machine('out', 'Locked box', [row('claude', 'signin', 'Sign in on Locked box: work'), row('codex', 'signin'), row('kimi', 'signin')]),
  machine('old', 'Old box', []),
];
const sheet = (request: any, agent: any, extra: Record<string, unknown> = {}) =>
  createElement(MoveSheet, { open: true, onClose: () => {}, request, chatId: 'c', machines: MACHINES, agent, moved: () => {}, ...extra });

test('the machine rows say, before the press, which machines cannot take the chat and why, for Claude Code, Codex and an ACP agent; they cannot be pressed', async () => {
  for (const [agent, label, signedOut] of [
    [CLAUDE, 'Claude Code', 'Sign in on Locked box: work'],
    [CODEX, 'Codex', 'Sign in to Codex on Locked box.'],
    [KIMI, 'Kimi', 'Sign in to Kimi on Locked box.'],
  ] as const) {
    const { request, calls } = rig();
    const v = await mount(sheet(request, agent));
    const text = v.host.textContent!;
    assert.ok(text.includes(`${label} isn't installed on Empty box.`), `${label}: not installed is said on the row`);
    assert.ok(text.includes(signedOut), `${label}: signed out is said on the row`);
    assert.ok(!text.includes('Sign in on Locked box: work') || label === 'Claude Code');
    // the rows are not buttons: a person cannot press them
    await assert.rejects(click('Empty box'), /button Empty box/);
    await assert.rejects(click('Locked box'), /button Locked box/);
    assert.equal(calls.length, 0, `${label}: a machine that cannot take it is not pressable, nothing is asked of it`);
    await click('Ready box');
    assert.deepEqual(calls[0], ['machines.folders', { id: 'ready' }], `${label}: a machine that can still opens`);
    await v.done();
  }
});

test('an older Mac that reports no agents, and a chat whose agent is not known, leave every machine pressable as before', async () => {
  const { request, calls } = rig();
  const v = await mount(sheet(request, null));
  await click('Empty box');
  assert.equal(calls[0]?.[0], 'machines.folders', 'no agent known: nothing is judged');
  await v.done();
  const again = rig();
  const w = await mount(sheet(again.request, CLAUDE));
  await click('Old box');
  assert.equal(again.calls[0]?.[0], 'machines.folders', 'a machine that reports no agents: the Host decides at the press');
  await w.done();
});

test('a refusal after the press is said by its fact, never the raw words and never one sentence for three causes; an older Host and a refusal of another kind keep working', async () => {
  const refuse = (code: string, message: string) => () => {
    throw Object.assign(new Error(message), { code });
  };
  const flow = async (move: () => never, agent = CLAUDE) => {
    const { request, calls } = rig(move);
    const v = await mount(sheet(request, agent));
    await click('Ready box');
    await click('Use this folder');
    await click('Leave the changes');
    const text = v.host.textContent!;
    await v.done();
    return { text, calls };
  };
  const raw = 'This host has no claude agent set up.';
  const older = await flow(refuse('harness_not_configured', raw));
  assert.ok(older.text.includes('Ready box is too old to take this chat. Update it.'));
  assert.ok(!older.text.includes(raw), 'an older Host’s raw words are not shown');
  assert.ok((await flow(refuse('agent_missing', raw), CODEX)).text.includes("Codex isn't installed on Ready box."));
  assert.ok((await flow(refuse('agent_signed_out', raw), KIMI)).text.includes('Sign in to Kimi on Ready box.'));
  assert.ok((await flow(refuse('agent_login_refused', raw))).text.includes("Claude Code's login on Ready box is refused. Sign in again."));
  // a newer Host's sentence for a fact this phone does not know (an older phone, a new code) and a plain failure: the Mac's words as they are
  const unknown = await flow(refuse('directory_missing', "That folder doesn't exist on Ready box."));
  assert.ok(unknown.text.includes("That folder doesn't exist on Ready box."));
  const plain = await flow(() => {
    throw new Error('The folder on Ready box is on another branch.');
  });
  assert.ok(plain.text.includes('on another branch'));
});

test('from the chat’s ⋯ the agent the chat runs on reaches the sheet: the machine that lacks it says so', async () => {
  const state = {
    phase: 'online',
    generation: 1,
    user: { id: 'u' },
    pairs: [{ pairId: 'p1', macId: 'm1', name: 'MacBook Pro' }],
    selectedPair: 'p1',
    presence: {},
    reconnect: null,
    outbox: [],
    error: null,
  };
  const runtime = {
    request: async (method: string) =>
      method === 'machine.hello' ? { capabilities: { machines: true } } : method === 'machines.list' ? { machines: MACHINES } : undefined,
    onEvent: () => () => undefined,
  };
  const { request } = rig();
  const controls = (harness: unknown) => ({ options: null, harness, switching: false, harnesses: [], methods: {} });
  for (const [harness, shown] of [
    [{ id: 'codex', label: 'Codex' }, "Codex isn't installed on Empty box."],
    [null, null],
  ] as const) {
    const header = createElement(ChatHeader, {
      request,
      chatId: 'c',
      title: 'Fix',
      back: () => {},
      reload: () => {},
      changed: () => {},
      controls: controls(harness),
      hostId: 'ready',
    });
    const v = await mount(createElement(MacLinkProvider, { state, runtime }, header));
    await flush();
    await flush();
    await click('Chat menu');
    await click('Move to another computer');
    assert.equal(
      v.host.textContent!.includes("Codex isn't installed on Empty box."),
      shown !== null,
      'the reason shows only when the chat’s agent is known',
    );
    await v.done();
  }
});
