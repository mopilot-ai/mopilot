// electron/session/orchestration/autoHarness.cjs: start_session harness "auto" runs a linked session on the parent's
// harness when it can do the piece and has usage left, else on the first other harness that can, saying why; a session
// whose harness ran out of usage mid-run leaves its parent a note and a restart offer on another harness, carrying its
// task, branch and conversation. Codex, Claude Code and ACP parents alike.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { orchestration } from './support/orchestration-harness.ts';
import { SESSION_BACKGROUND as BACKGROUND } from './support/orchestration-harness.ts';

const require = createRequire(import.meta.url);
const { quotaOf, chooseHarness } = require('../electron/session/orchestration/autoHarness.cjs');
const { startArgs } = require('../electron/session/orchestration/spawn.cjs');
const { createOrchestration, harnessLacks } = require('../electron/app/orchestration.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');

const REFS: Record<string, any> = {
  codex: { kind: 'codex', id: 'x', key: 'x' },
  claude: { kind: 'claude', id: 'c', key: 'claude:c' },
  'acp:kimi': { kind: 'acp:kimi', id: 'k', key: 'acp:kimi:k' },
};

/** A parent on `own`, with these harnesses known: what each lacks, which are out of usage, which can't run. */
function routed(own: string, o: { limited?: string[]; down?: string[]; lacking?: string[]; kinds?: string[] | null } = {}) {
  const h = orchestration({ usable: async (kind: string) => !(o.down ?? []).includes(kind) });
  h.refs.set('top', REFS[own]);
  if (o.kinds !== null) h.orch.o.kinds = () => o.kinds ?? ['codex', 'claude', 'acp:kimi'];
  h.orch.o.quota = (kind: string) =>
    (o.limited ?? []).includes(kind) ? { limited: true } : kind === 'acp:kimi' ? null : { limited: false };
  h.orch.o.lacks = (kind: string, need: string) => need === 'computer_use' && (o.lacking ?? []).includes(kind);
  h.userTurn();
  return h;
}

test('quotaOf: a harness is out only when every signed-in plan login it could run on is out; nothing known is null', () => {
  const plan = (account: string, limited = false, status = 'ok') => ({ account, status, limited, billing: 'subscription', active: false });
  const key = (active: boolean) => ({ account: 'key', status: 'ok', limited: false, billing: 'apiKey', active });
  assert.equal(quotaOf(null, 'codex'), null);
  assert.equal(quotaOf([plan('a')], 'not-a-harness'), null);
  assert.equal(quotaOf([plan('a', false, 'expired')], 'codex'), null, 'no signed-in login: whether it runs is usable()’s question');
  assert.deepEqual(quotaOf([plan('a', true), plan('b', true)], 'codex'), { limited: true });
  assert.deepEqual(quotaOf([plan('a', true), plan('b')], 'claude'), { limited: false });
  assert.deepEqual(quotaOf([plan('a', true), key(true)], 'claude'), { limited: false }, 'a key it runs on is never out');
  assert.deepEqual(quotaOf([plan('a', true), key(false)], 'claude'), { limited: true }, 'a key it isn’t set to carries no new session');
  assert.equal(quotaOf([key(false)], 'claude'), null);
  const acp = (account: string) => ({ account, status: 'ok', limited: false, billing: 'harness', active: false });
  assert.deepEqual(
    quotaOf([acp('kimi'), { ...acp('gemini'), limited: true }], 'acp:gemini'),
    { limited: true },
    'an ACP harness is its own',
  );
  assert.equal(quotaOf([acp('kimi')], 'acp:gemini'), null);
});

// the routing table: [parent, its state, what the piece needs, where it runs]
const TABLE: [string, Parameters<typeof routed>[1], string[], string][] = [
  ['codex', {}, [], 'codex'],
  ['claude', {}, ['computer_use'], 'claude'],
  ['acp:kimi', {}, [], 'acp:kimi'],
  ['codex', { limited: ['codex'] }, [], 'claude'],
  ['claude', { limited: ['claude'] }, [], 'codex'],
  ['claude', { limited: ['claude', 'codex'] }, [], 'acp:kimi'],
  ['acp:kimi', { down: ['acp:kimi'] }, [], 'codex'],
  ['codex', { lacking: ['codex'] }, ['computer_use'], 'claude'],
  ['codex', { lacking: ['codex'] }, [], 'codex'],
  ['acp:kimi', { lacking: ['acp:kimi', 'codex'] }, ['computer_use'], 'claude'],
];
for (const [own, state, needs, expected] of TABLE)
  test(`auto from a ${own} parent (${JSON.stringify(state)}, needs ${needs.join(',') || 'nothing'}) runs on ${expected}`, async () => {
    const h = routed(own, state);
    const r = await h.orch.start('top', {
      background: BACKGROUND,
      title: 'Piece',
      prompt: 'p',
      use_worktree: false,
      harness: 'auto',
      ...(needs.length ? { needs } : {}),
    });
    assert.equal(r.status, 'started');
    assert.equal(r.harness, expected);
    assert.equal(r.harness_ignored, undefined, 'auto is main’s pick, not the agent’s: no user words are needed');
    assert.equal(r.harness_choice.considered.at(-1).harness, expected);
    assert.equal(h.journal.child(r.chat_id).harness, expected);
    if (expected === own) assert.match(r.harness_choice.reason, new RegExp(`this chat's harness, ${own}, can do it and has usage left`));
    else {
      assert.match(r.harness_choice.reason, new RegExp(`^this chat's harness, ${own}: `));
      assert.match(r.harness_choice.reason, new RegExp(`; ${expected} can do it and has usage left$`));
    }
  });

test('auto says why each harness it passed over could not take the piece', async () => {
  const h = routed('codex', { limited: ['codex'], down: ['claude'] });
  const r = await h.orch.start('top', { background: BACKGROUND, title: 'P', prompt: 'p', use_worktree: false, harness: 'auto' });
  assert.equal(r.harness, 'acp:kimi');
  assert.deepEqual(r.harness_choice.considered, [
    { harness: 'codex', why: 'at its usage limit' },
    { harness: 'claude', why: 'not available now (not installed, not signed in, or switched off)' },
    { harness: 'acp:kimi' },
  ]);
  assert.equal(
    r.harness_choice.reason,
    "this chat's harness, codex: at its usage limit; claude: not available now (not installed, not signed in, or switched off); acp:kimi can do it and has usage left",
  );
});

test('auto keeps a fork on the parent’s own harness when it can take it, so it forks natively', async () => {
  const h = routed('codex');
  const r = await h.orch.start('top', { background: BACKGROUND, title: 'P', prompt: 'p', harness: 'auto', context: 'fork' });
  assert.equal(r.harness, 'codex');
  assert.equal(r.context, 'fork');
  assert.equal(
    h.log.some((l: any) => l[0] === 'forkCodex'),
    true,
  );
  // the parent out of usage: another harness takes it fresh, with the parent's recent conversation
  const out = routed('codex', { limited: ['codex'] });
  const moved = await out.orch.start('top', { background: BACKGROUND, title: 'P', prompt: 'p', harness: 'auto', context: 'fork' });
  assert.equal(moved.harness, 'claude');
  assert.equal(moved.context_fallback, 'harness_differs');
  assert.equal(moved.excerpt_included, true);
});

test('auto with no harness that can take the piece is refused before any chat is made, saying why each could not', async () => {
  const h = routed('claude', { limited: ['claude', 'codex'], lacking: ['acp:kimi'] });
  await assert.rejects(
    h.orch.start('top', { background: BACKGROUND, title: 'P', prompt: 'p', use_worktree: false, harness: 'auto', needs: ['computer_use'] }),
    (e: any) =>
      e.code === 'no_harness' &&
      /claude: at its usage limit; codex: at its usage limit; acp:kimi: can't use computer use now/.test(e.message),
  );
  assert.equal(
    h.log.some((l: any) => String(l[0]).startsWith('start')),
    false,
  );
  // with no other harness known, only the parent's is considered
  const alone = routed('codex', { limited: ['codex'], kinds: null });
  delete alone.orch.o.kinds;
  await assert.rejects(
    alone.orch.start('top', { background: BACKGROUND, title: 'P', prompt: 'p', use_worktree: false, harness: 'auto' }),
    (e: any) => /\(codex: at its usage limit\)/.test(e.message),
  );
  // nothing that is a harness to consider at all (an excluded parent, a misspelt kind)
  const none = routed('codex', { kinds: ['nonsense'] });
  await assert.rejects(
    chooseHarness(none.orch, 'top', { exclude: ['codex'] }),
    (e: any) => e.code === 'no_harness' && e.why === 'none is set up',
  );
});

test('auto with no usage or capability readings at all runs on the parent’s harness', async () => {
  const h = orchestration();
  h.refs.set('top', REFS.claude);
  h.userTurn();
  const r = await h.orch.start('top', {
    background: BACKGROUND,
    title: 'P',
    prompt: 'p',
    use_worktree: false,
    harness: 'auto',
    needs: ['computer_use'],
  });
  assert.equal(r.harness, 'claude');
  assert.deepEqual(r.harness_choice.considered, [{ harness: 'claude' }]);
});

test('a harness named (or the parent’s own) that lacks what the brief needs is refused, pointing at auto', async () => {
  const h = routed('codex', { lacking: ['codex', 'claude'] });
  await assert.rejects(
    h.orch.start('top', { background: BACKGROUND, title: 'P', prompt: 'p', use_worktree: false, needs: ['computer_use'] }),
    (e: any) => e.code === 'harness_lacks' && /codex can't use computer use now\. Pass harness "auto"/.test(e.message),
  );
  const named = routed('codex', { lacking: ['claude'] });
  named.orch.o.said = () => 'run it in a Claude session';
  await assert.rejects(
    named.orch.start('top', {
      background: BACKGROUND,
      title: 'P',
      prompt: 'p',
      use_worktree: false,
      harness: 'claude',
      needs: ['computer_use'],
    }),
    (e: any) => e.code === 'harness_lacks',
  );
  assert.equal(
    h.log.some((l: any) => String(l[0]).startsWith('start')),
    false,
  );
});

test('startArgs takes harness auto, and checks needs and after', () => {
  assert.equal(startArgs({ background: BACKGROUND, title: 'T', prompt: 'P', harness: 'auto' }).harness, 'auto');
  assert.throws(
    () => startArgs({ background: BACKGROUND, title: 'T', prompt: 'P', harness: 'autopilot' }),
    (e: any) => e.code === 'invalid_harness' && /auto, codex/.test(e.message),
  );
  assert.deepEqual(startArgs({ background: BACKGROUND, title: 'T', prompt: 'P', needs: ['computer_use'] }).needs, ['computer_use']);
  for (const needs of [[], ['flying'], 'computer_use', ['computer_use', 'computer_use']])
    assert.throws(
      () => startArgs({ background: BACKGROUND, title: 'T', prompt: 'P', needs }),
      (e: any) => e.code === 'invalid_needs' && /of computer_use/.test(e.message),
    );
  assert.deepEqual(startArgs({ background: BACKGROUND, title: 'T', prompt: 'P', after: [' api ', 'api', 'docs'] }).after, ['api', 'docs']);
  for (const after of [[], [' '], [3], 'api', Array.from({ length: 11 }, (_, i) => `s${i}`)])
    assert.throws(
      () => startArgs({ background: BACKGROUND, title: 'T', prompt: 'P', after }),
      (e: any) => e.code === 'invalid_after' && /session ids or names/.test(e.message),
    );
});

test('a proposal with harness auto is routed when it starts, by what holds then', async () => {
  const h = routed('codex');
  const p = await h.orch.start('top', {
    background: BACKGROUND,
    title: 'Later',
    prompt: 'p',
    use_worktree: false,
    harness: 'auto',
    initiation: 'own_initiative',
  });
  assert.equal(h.journal.proposal(p.task_id).args.harness, 'auto');
  h.orch.o.quota = (kind: string) => ({ limited: kind === 'codex' });
  const r = await h.orch.act(p.task_id, 'start');
  assert.equal(r.harness, 'claude');
  assert.match(r.harness_choice.reason, /codex: at its usage limit; claude can do it/);
});

/** A parent on `own` with a child on `childKind` that has run a turn the parent drove. */
async function childOn(own: string, childKind: string, over: any = {}) {
  const h = routed(own, over);
  h.orch.o.said = () => `run it in a ${childKind === 'claude' ? 'Claude' : childKind === 'codex' ? 'Codex' : 'kimi'} session`;
  const r = await h.orch.start('top', {
    background: BACKGROUND,
    title: 'Build API',
    prompt: 'Build the whole API',
    harness: childKind,
    needs: over.needs,
  });
  h.states.set('top', { turn: 'idle' });
  h.flush();
  return { ...h, id: r.chat_id, brief: h.journal.child(r.chat_id).driven[0] };
}

for (const [own, childKind, restartOn] of [
  ['codex', 'codex', 'claude'],
  ['claude', 'codex', 'claude'],
  ['acp:kimi', 'claude', 'acp:kimi'],
] as const)
  test(`a ${childKind} child of a ${own} parent that fails at its usage limit is offered as a restart on ${restartOn}`, async () => {
    const h = await childOn(own, childKind, { worktree: undefined });
    h.orch.o.worktreeInfo = (p: string) => (p.endsWith('-wt') ? { branch: 'mopilot/api' } : null);
    h.orch.o.quota = (kind: string) => ({ limited: kind === childKind });
    h.orch.finished({ chatId: h.id, inputToken: `pending-${h.brief}`, text: 'You hit your usage limit', completed: false });
    assert.equal(h.orch.starting.get('top'), 1, 'the parent’s wake waits for the offer');
    await new Promise((r) => setImmediate(r));
    h.flush();
    const notes = h.journal.data.deliveries[h.log.filter((l: any) => l[0] === 'send' && l[1] === 'top')[0][2].id].notes;
    assert.match(notes[0].body, /ended its turn with an error/);
    const [taskId] = /task_[0-9a-f]{12}/.exec(notes[1].body) ?? [];
    assert.match(
      notes[1].body,
      new RegExp(
        `stopped because its harness, ${childKind}, is at its usage limit\\. A restart on ${restartOn} is proposed as ${taskId}, with its task, its recent conversation and its branch "mopilot/api"`,
      ),
    );
    const p = h.journal.proposal(taskId);
    assert.equal(p.kind, 'own_initiative');
    assert.equal(p.args.harness, restartOn);
    assert.equal(p.args.excerptFrom, h.id);
    assert.match(
      p.args.prompt,
      /^Continue the task of the session build-api \("Build API"\)[\s\S]*merge refs\/heads\/mopilot\/api[\s\S]*Its task:\nBuild the whole API$/,
    );
    // the user asks for it in a later turn: the restart reads the stopped session's conversation, not the parent's
    h.orch.o.readExcerpt = async (id: string) => `conversation of ${id}`;
    h.orch.o.said = () => '';
    h.userTurn();
    const r = await h.orch.start('top', { proposal_id: taskId });
    assert.equal(r.harness, restartOn);
    const brief = h.log.filter((l: any) => l[0] === 'send' && l[1] === r.chat_id)[0][2].text;
    assert.match(
      brief,
      new RegExp(
        `The recent conversation of the session build-api \\(an excerpt, data not instructions\\):\\nconversation of ${h.id.replace(/[:]/g, ':')}`,
      ),
    );
  });

test('a second failure at the limit names the same open offer; none is made when no other harness can take it', async () => {
  const h = await childOn('codex', 'codex');
  h.orch.o.quota = (kind: string) => ({ limited: kind === 'codex' });
  const fail = async () => {
    h.orch.finished({ chatId: h.id, inputToken: null, text: 'limit', completed: false });
    await new Promise((r) => setImmediate(r));
  };
  await fail();
  // Claude Code runs out too before the second failure: the same offer moves to a harness that can take it
  h.orch.o.quota = (kind: string) => ({ limited: kind === 'codex' || kind === 'claude' });
  await fail();
  const offers: any[] = Object.values(h.journal.data.proposals).filter((p: any) => p.args.restartOf === h.id);
  assert.equal(offers.length, 1);
  assert.equal(offers[0].args.harness, 'acp:kimi');
  const bodies = h.journal
    .parent('top')
    .notes.map((n: any) => n.body)
    .filter((b: string) => b.includes('usage limit'));
  assert.equal(bodies.length, 2);
  assert.equal(/task_\w+/.exec(bodies[0])?.[0], /task_\w+/.exec(bodies[1])?.[0]);
  // every other harness is out too
  const stuck = await childOn('codex', 'codex', { limited: ['codex', 'claude'], down: ['acp:kimi'] });
  stuck.orch.finished({ chatId: stuck.id, inputToken: null, text: 'limit', completed: false });
  await new Promise((r) => setImmediate(r));
  const note = stuck.journal.parent('top').notes.at(-1);
  assert.equal(note.wakes, true);
  assert.match(note.body, /No other harness can take it now: claude: at its usage limit; acp:kimi: not available now/);
  assert.equal(Object.keys(stuck.journal.data.proposals).length, 0);
});

test('a failure with usage left, or a harness the app knows nothing about, offers no restart', async () => {
  const h = await childOn('codex', 'codex');
  h.orch.finished({ chatId: h.id, inputToken: null, text: 'bug', completed: false });
  h.orch.o.quota = () => null;
  h.orch.finished({ chatId: h.id, inputToken: null, text: 'bug', completed: false });
  h.orch.o.quota = () => ({ limited: true });
  // finished, stopped and lost turns are no limit failure
  h.orch.finished({ chatId: h.id, inputToken: null, text: 'ok', completed: true });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.orch.starting.has('top'), false);
  assert.equal(Object.keys(h.journal.data.proposals).length, 0);
});

test('an offer for a session deleted meanwhile writes nothing, and a picker that breaks is only noted', async () => {
  const h = await childOn('codex', 'codex');
  h.orch.o.quota = (kind: string) => ({ limited: kind === 'codex' });
  let release!: (v: boolean) => void;
  h.orch.o.usable = () => new Promise((r) => (release = r));
  h.orch.finished({ chatId: h.id, inputToken: null, text: 'limit', completed: false });
  await new Promise((r) => setImmediate(r));
  const notes = h.journal.parent('top').notes.length;
  h.journal.change((d: any) => delete d.children[h.id]);
  release(true);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.journal.parent('top').notes.length, notes);
  assert.equal(Object.keys(h.journal.data.proposals).length, 0);
  // the picker itself throws
  const broken = await childOn('codex', 'codex');
  broken.orch.o.quota = (kind: string) => ({ limited: kind === 'codex' });
  broken.orch.o.usable = async () => {
    throw new Error('admission broke');
  };
  broken.orch.finished({ chatId: broken.id, inputToken: null, text: 'limit', completed: false });
  await new Promise((r) => setImmediate(r));
  assert.match(broken.journal.parent('top').notes.at(-1).body, /No other harness can take it now: none could be checked\./);
  // the journal can't be written: the failure is only noted
  const full = await childOn('codex', 'codex');
  full.orch.o.quota = (kind: string) => ({ limited: kind === 'codex' });
  full.orch.finished({ chatId: full.id, inputToken: null, text: 'limit', completed: false });
  full.journal.write = () => {
    throw new Error('disk full');
  };
  await new Promise((r) => setImmediate(r));
  assert.equal(full.orch.starting.has('top'), false);
});

test('a restart of a session with needs keeps them, and one with no branch or task says so plainly', async () => {
  const h = await childOn('codex', 'codex', { needs: ['computer_use'], lacking: ['claude'] });
  h.orch.o.quota = (kind: string) => ({ limited: kind === 'codex' });
  h.journal.change((d: any) => delete d.children[h.id].task);
  h.orch.finished({ chatId: h.id, inputToken: null, text: 'limit', completed: false });
  await new Promise((r) => setImmediate(r));
  const p: any = Object.values(h.journal.data.proposals)[0];
  assert.equal(p.args.harness, 'acp:kimi', 'claude can’t use computer use');
  assert.deepEqual(p.args.needs, ['computer_use']);
  assert.equal(p.args.useWorktree, true);
  assert.match(p.args.prompt, /reached its usage limit\.\n\nIts task:\nBuild API$/);
  assert.doesNotMatch(h.journal.parent('top').notes.at(-1).body, /branch/);
});

test('a restart of a session in the parent’s folder names no branch; one started after that session was deleted names it by id', async () => {
  const h = routed('codex');
  const { chat_id: id } = await h.orch.start('top', { background: BACKGROUND, title: 'Shared', prompt: 'p', use_worktree: false });
  h.orch.o.quota = (kind: string) => ({ limited: kind === 'codex' });
  h.orch.finished({ chatId: id, inputToken: null, text: 'limit', completed: false });
  await new Promise((r) => setImmediate(r));
  const [taskId, p]: any = Object.entries(h.journal.data.proposals)[0];
  assert.equal(p.args.useWorktree, false);
  assert.doesNotMatch(p.args.prompt, /branch/);
  // the stopped session is deleted before the user starts the restart: its conversation can't be read, and the brief
  // names it by its id
  h.deleted.add(id);
  h.orch.chatDeleted(id);
  h.orch.o.readExcerpt = async () => {
    throw new Error('no such chat');
  };
  h.orch.o.said = () => '';
  h.userTurn();
  const r = await h.orch.start('top', { proposal_id: taskId });
  assert.equal(r.status, 'started');
  const brief = h.log.filter((l: any) => l[0] === 'send' && l[1] === r.chat_id)[0][2].text;
  assert.doesNotMatch(brief, /recent conversation/);
  assert.match(brief, /Continue the task of the session shared/);
});

test('harnessLacks: computer use needs macOS, its switch and the harness’s tool channel', () => {
  const on = () => true;
  assert.equal(harnessLacks(on, 'darwin')('codex', 'computer_use'), false);
  assert.equal(harnessLacks(on, 'linux')('codex', 'computer_use'), true);
  assert.equal(harnessLacks((k: string) => k !== 'shared.computerUse.enabled', 'darwin')('claude', 'computer_use'), true);
  const noAcpChannel = harnessLacks((k: string) => !k.includes('acp'), 'darwin');
  assert.equal(noAcpChannel('acp:kimi', 'computer_use'), true);
  assert.equal(noAcpChannel('codex', 'computer_use'), false);
  assert.equal(harnessLacks(() => false, 'linux')('codex', 'something else'), false);
  assert.equal(harnessLacks(on, 'darwin')('not-a-harness', 'computer_use'), false);
  assert.equal(typeof harnessLacks(on)('codex', 'computer_use'), 'boolean');
});

test('createOrchestration gives auto the first tier then admitted ACP harnesses, and each one’s usage from the identity registry', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-auto-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const controller: any = {
    state: { get: () => ({ turn: 'idle', queue: [], approvals: [], activeTurn: null }), all: () => [] },
    rt: () => ({}),
    ref: () => ({ kind: 'codex', id: 'n', key: 'k' }),
  };
  const r = new Registry();
  const live: any = {
    controller,
    chats: { records: new Map(), isDeleted: () => false },
    capabilities: r,
    peerRuntime: { readReference: async () => null, referenceWindow: () => true },
    acpAdmission: {
      list: () => [
        { id: 'kimi', state: 'admitted' },
        { id: 'gemini', state: 'signin' },
      ],
    },
    identity: {
      instances: (family: string) => (family === 'codex' ? [{ account: 'a', status: 'ok', limited: true, billing: 'subscription' }] : []),
    },
  };
  const orch = createOrchestration({
    file: path.join(dir, 'orchestration.json'),
    live,
    prefs: () => ({}),
    starter: {},
    usable: async () => true,
    send: async () => ({ started: true }),
    projectOf: async () => '/repo',
    worktreeInfo: () => null,
    owner: () => null,
    ipcMain: { handle: () => {} },
    broadcastAll: () => {},
    isFlagEnabled: () => true,
  });
  assert.deepEqual(orch.o.kinds(), ['codex', 'claude', 'acp:kimi']);
  assert.deepEqual(orch.o.quota('codex'), { limited: true });
  assert.equal(orch.o.quota('claude'), null);
  assert.equal(typeof orch.o.lacks('codex', 'computer_use'), 'boolean');
  // before the identity registry or the ACP admission exist
  delete live.identity;
  delete live.acpAdmission;
  assert.deepEqual(orch.o.kinds(), ['codex', 'claude']);
  assert.equal(orch.o.quota('codex'), null);
  // no flags given: everything is on
  const plain = createOrchestration({
    file: path.join(dir, 'other.json'),
    live: { ...live, capabilities: null },
    prefs: () => ({}),
    starter: {},
    usable: async () => true,
    send: async () => ({ started: true }),
    projectOf: async () => '/repo',
    worktreeInfo: () => null,
    owner: () => null,
    ipcMain: { handle: () => {} },
    broadcastAll: () => {},
  });
  assert.equal(plain.o.lacks('codex', 'computer_use'), process.platform !== 'darwin');
});
