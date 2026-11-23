// electron/momo/mainChat.cjs (#2139): MoMo's brain (prefs momo.brain.main) and how a change reaches its main chat on
// Codex, Claude Code and a basic (ACP) harness: now, through the chat's own switch with its next message, or as a new
// main chat; through the existing account pins; refused for a harness that can't run, a switch with no model, or while busy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { switched, world } from './support/momoWorld.ts';

test('setting the brain: refused when it names no harness or can’t be saved; with no main chat yet it is only saved', async () => {
  const w = world({ prefs: { momo: { feed: true } } });
  await assert.rejects(w.svc.setBrain({ harness: 'gemini' }), { code: 'invalid_brain' });
  await assert.rejects(w.svc.setBrain(null), { code: 'invalid_brain' });
  const r = await w.svc.setBrain({ harness: 'claude', account: 'du@work', model: 'opus', modelLabel: 'Opus', extra: 1 });
  assert.deepEqual(r, {
    brain: { harness: 'claude', account: 'du@work', model: 'opus', modelLabel: 'Opus', effort: null },
    chatId: null,
    applied: 'saved',
    warning: null,
  });
  assert.deepEqual(w.prefs.momo, { feed: true, brain: { main: r.brain } });
  // every window's chip hears of it
  assert.deepEqual(w.brains.at(-1), r.brain);
  w.failPatch = true;
  await assert.rejects(w.svc.setBrain({ harness: 'codex' }), { code: 'save_failed' });
  assert.equal(w.svc.getBrain().harness, 'claude');
  // the chat made later starts on it
  w.failPatch = false;
  const { chatId } = await w.svc.ensureMainChat();
  assert.deepEqual(w.claude.own.get(chatId), { model: 'opus', effort: null, account: 'du@work' });
});

test('same harness: a new account or model applies now, and a switch chosen for an earlier brain is dropped', async () => {
  const w = world({ prefs: { momo: { brain: { main: { harness: 'claude' } } } } });
  const { chatId } = await w.svc.ensureMainChat();
  w.state.patch(chatId, { pendingSwitch: { harness: 'codex', model: 'gpt-5', modelLabel: 'gpt-5', mode: 'auto' } });
  w.claude.own.set(chatId, { model: 'opus', effort: 'high', account: null });
  const r = await w.svc.setBrain({ harness: 'claude', account: 'du@home', model: 'sonnet' });
  assert.equal(r.applied, 'now');
  assert.equal(r.chatId, chatId);
  assert.equal(w.state.get(chatId).pendingSwitch, null);
  assert.deepEqual(w.claude.own.get(chatId), { model: 'sonnet', effort: 'high', account: 'du@home' });
  assert.deepEqual(w.chats.records.get(chatId).meta.account, { id: 'du@home', pinned: true });
});

test('Codex to Claude Code: a switch in place that the next message settles, on the brain’s account and model', async () => {
  const w = world();
  const { chatId } = await w.svc.ensureMainChat();
  const r = await w.svc.setBrain({ harness: 'claude', account: 'du@work', model: 'sonnet', modelLabel: 'Sonnet' });
  assert.deepEqual(r, { brain: r.brain, chatId, applied: 'nextMessage', warning: null });
  assert.deepEqual(w.state.get(chatId).pendingSwitch, {
    harness: 'claude',
    model: 'sonnet',
    modelLabel: 'Sonnet',
    mode: 'auto',
    account: 'du@work',
    goal: null,
  });
  // no model picked: the harness's default, by its id where no label is given
  await w.svc.setBrain({ harness: 'claude' });
  assert.deepEqual(w.state.get(chatId).pendingSwitch, {
    harness: 'claude',
    model: 'opus',
    modelLabel: 'opus',
    mode: 'auto',
    account: null,
    goal: null,
  });
  // no model known at all: the switch isn't recorded, and the user is asked for one
  w.prefs = { ...w.prefs, claudeSelection: undefined };
  await assert.rejects(w.svc.setBrain({ harness: 'claude', account: 'du@home' }), {
    code: 'no_model',
    message: 'Pick a model for MoMo on Claude Code.',
  });
  assert.equal(w.state.get(chatId).pendingSwitch.account, null);
  assert.equal(w.svc.getBrain().account, null);
  // back to where it is before the message went: no switch at all
  await w.svc.setBrain({ harness: 'codex' });
  assert.equal(w.state.get(chatId).pendingSwitch, null);
  // after a restart (the pending switch is gone with the session state) the chat is brought to the brain again
  await w.svc.setBrain({ harness: 'claude', model: 'sonnet' });
  w.state.patch(chatId, { pendingSwitch: null });
  assert.deepEqual(await w.svc.ensureMainChat(), { chatId, warning: null });
  assert.equal(w.state.get(chatId).pendingSwitch.harness, 'claude');
  // once the switch committed a Claude segment, reopening MoMo leaves it as it is, and a brain change applies on it
  switched(w, chatId, 'claude', 'sess-1');
  w.state.patch(chatId, { pendingSwitch: null });
  assert.deepEqual(await w.svc.ensureMainChat(), { chatId, warning: null });
  assert.equal(w.state.get(chatId).pendingSwitch, null);
  assert.equal((await w.svc.setBrain({ harness: 'claude', model: 'haiku' })).applied, 'now');
  assert.equal(w.claude.own.get(chatId).model, 'haiku');
});

test('Claude Code to Codex: the switch carries the Codex default model when the brain names none', async () => {
  const w = world({ prefs: { momo: { brain: { main: { harness: 'claude' } } }, model: 'gpt-5' } });
  const { chatId } = await w.svc.ensureMainChat();
  await w.svc.setBrain({ harness: 'codex', account: 'cx-home' });
  assert.deepEqual(w.state.get(chatId).pendingSwitch, {
    harness: 'codex',
    model: 'gpt-5',
    modelLabel: 'gpt-5',
    mode: 'auto',
    account: 'cx-home',
    goal: null,
  });
});

test('to or from ACP: keep the main chat, refuse while working and retain waiting input', async () => {
  const w = world();
  const { chatId } = await w.svc.ensureMainChat();
  w.state.patch(chatId, { turn: 'running' });
  await assert.rejects(w.svc.setBrain({ harness: 'acp:opencode' }), { code: 'busy' });
  w.state.patch(chatId, { turn: 'awaitingUser' });
  await assert.rejects(w.svc.setBrain({ harness: 'acp:opencode' }), { code: 'busy' });
  w.state.patch(chatId, { turn: 'crashed', queue: [{ id: 'q' }] });
  const r = await w.svc.setBrain({ harness: 'acp:opencode' });
  assert.equal(r.applied, 'nextMessage');
  assert.equal(r.chatId, chatId);
  assert.equal(w.state.get(chatId).pendingSwitch.harness, 'acp:opencode');
  assert.equal(w.state.get(chatId).pendingSwitch.model, '');
  assert.equal(w.state.get(chatId).queue[0].id, 'q');
  assert.equal(w.chats.records.get(chatId).meta.momo, 'main');
  switched(w, chatId, 'acp:opencode', 'native-acp');
  w.state.patch(chatId, { turn: 'idle', queue: [], pendingSwitch: null });
  const back = await w.svc.setBrain({ harness: 'claude', account: 'du@work', model: 'opus' });
  assert.equal(back.applied, 'nextMessage');
  assert.equal(back.chatId, chatId);
  assert.equal(w.state.get(chatId).pendingSwitch.account, 'du@work');
});

test('a switch with no selected first-tier model leaves the brain and chat unchanged', async () => {
  const w = world({ prefs: { momo: { brain: { main: { harness: 'acp:opencode' } } } } });
  const { chatId } = await w.svc.ensureMainChat();
  await assert.rejects(w.svc.setBrain({ harness: 'codex' }), { code: 'no_model' });
  assert.equal(w.svc.getBrain().harness, 'acp:opencode');
  assert.equal(w.svc.mainChatId(), chatId);
});

test('a brain changed outside a running turn becomes a pending ACP switch without replacing the chat', async () => {
  const w = world();
  const { chatId } = await w.svc.ensureMainChat();
  w.state.patch(chatId, { turn: 'running' });
  w.prefs = { ...w.prefs, momo: { brain: { main: { harness: 'acp:opencode' } } } };
  assert.deepEqual(await w.svc.ensureMainChat(), { chatId, warning: null });
  assert.equal(w.state.get(chatId).pendingSwitch.harness, 'acp:opencode');
  w.state.patch(chatId, { turn: 'idle' });
  assert.equal((await w.svc.ensureMainChat()).chatId, chatId);
});

test('a harness that can’t run now never becomes the brain', async () => {
  const w = world();
  const { chatId } = await w.svc.ensureMainChat();
  w.unusable.add('acp:opencode');
  await assert.rejects(w.svc.setBrain({ harness: 'acp:opencode' }), {
    code: 'unavailable',
    message: "opencode isn't available now: it is not installed, not signed in, or turned off.",
  });
  assert.equal(w.svc.getBrain().harness, 'codex');
  assert.equal(w.svc.mainChatId(), chatId);
  // turned off while it checked
  w.unusable.clear();
  w.svc.o.usable = async () => ((w.allowed = false), true);
  await assert.rejects(w.svc.setBrain({ harness: 'claude', model: 'opus' }), { code: 'not_allowed' });
  w.allowed = true;
  assert.equal(w.svc.getBrain().harness, 'codex');
});

test('a switch already chosen for the brain is left as it is; an unfinished goal goes on after it', async () => {
  const w = world();
  const { chatId } = await w.svc.ensureMainChat();
  w.state.patch(chatId, { goal: { objective: 'ship it', status: 'active' } });
  await w.svc.setBrain({ harness: 'claude', model: 'sonnet' });
  assert.equal(w.state.get(chatId).pendingSwitch.goal, 'ship it');
  // the user unticked "continue the goal" in the switch sheet: reopening MoMo doesn't put it back
  w.state.patch(chatId, { pendingSwitch: { ...w.state.get(chatId).pendingSwitch, goal: null } });
  await w.svc.ensureMainChat();
  assert.equal(w.state.get(chatId).pendingSwitch.goal, null);
  // a finished goal isn't carried
  w.state.patch(chatId, { pendingSwitch: null, goal: { objective: 'done', status: 'complete' } });
  await w.svc.ensureMainChat();
  assert.equal(w.state.get(chatId).pendingSwitch.goal, null);
  // a brain whose harness has no model known: the chat stays where it is and the user is asked for one
  w.state.patch(chatId, { pendingSwitch: null });
  w.prefs = { momo: { brain: { main: { harness: 'claude' } } } };
  assert.deepEqual(await w.svc.ensureMainChat(), { chatId, warning: 'Pick a model for MoMo on Claude Code.' });
  assert.equal(w.state.get(chatId).pendingSwitch, null);
});

test('edges: a Codex chat with no config of its own, a harness with no default model, a basic harness its quirks don’t name', async () => {
  const w = world({ prefs: { momo: { brain: { main: { harness: 'codex' } } } } });
  const { chatId } = await w.svc.ensureMainChat();
  w.chats.patchMeta(chatId, { config: null });
  await w.svc.setBrain({ harness: 'codex', model: 'gpt-5-codex' });
  assert.deepEqual(w.chats.records.get(chatId).meta.config, { model: 'gpt-5-codex' });
  // on Claude Code, a switch to Codex with no Codex model anywhere is asked for
  const c = world({ prefs: { momo: { brain: { main: { harness: 'claude' } } } } });
  await c.svc.ensureMainChat();
  await assert.rejects(c.svc.setBrain({ harness: 'codex' }), { code: 'no_model', message: 'Pick a model for MoMo on Codex.' });
  // a basic harness the quirks don't describe goes by its id, and can't be confined (#2278)
  w.unusable.add('acp:zzz');
  await assert.rejects(w.svc.setBrain({ harness: 'acp:zzz' }), {
    code: 'unconfined',
    message: "zzz can't be MoMo's brain: its own file and shell tools can't be turned off.",
  });
  // nor can one whose quirks have no isolation: refused before it is even asked whether it can run
  await assert.rejects(w.svc.setBrain({ harness: 'acp:kimi' }), { code: 'unconfined', message: /^Kimi Code can't be MoMo's brain/ });
});

test('a main chat whose brain was cleared from prefs stays as it is', async () => {
  const w = world();
  const { chatId } = await w.svc.ensureMainChat();
  w.prefs = {};
  assert.deepEqual(await w.svc.ensureMainChat(), { chatId, warning: null });
  assert.equal(w.state.get(chatId).pendingSwitch, null);
});

test('while a turn runs only the model may change: no account re-pin, no switch while one settles', async () => {
  const w = world({ prefs: { momo: { brain: { main: { harness: 'claude', account: 'du@work', model: 'opus' } } } } });
  const { chatId } = await w.svc.ensureMainChat();
  // a turn running (the controller marks it so before a pending switch settles, SwitchRunner.perform)
  w.state.patch(chatId, { turn: 'running' });
  await assert.rejects(w.svc.setBrain({ harness: 'claude', account: 'du@home', model: 'opus' }), { code: 'busy' });
  await assert.rejects(w.svc.setBrain({ harness: 'codex', model: 'gpt-5' }), { code: 'busy' });
  assert.deepEqual(w.chats.records.get(chatId).meta.account, { id: 'du@work', pinned: true });
  assert.equal(w.state.get(chatId).pendingSwitch, null);
  assert.equal(w.svc.getBrain().account, 'du@work');
  // the model alone applies to the next turn, and the login isn't pinned again mid-turn
  const pins: any[] = [];
  const patch = w.chats.patchMeta.bind(w.chats);
  w.chats.patchMeta = (id: string, p: any) => (p.account && pins.push(p.account), patch(id, p));
  const r = await w.svc.setBrain({ harness: 'claude', account: 'du@work', model: 'sonnet' });
  assert.equal(r.applied, 'now');
  assert.equal(w.claude.own.get(chatId).model, 'sonnet');
  assert.deepEqual(pins, []);
  w.chats.patchMeta = patch;
  // the saved brain gone from prefs: nothing says the chat is settled on it, so even a model waits for the turn
  w.prefs = {};
  await assert.rejects(w.svc.setBrain({ harness: 'claude', model: 'haiku' }), { code: 'busy' });
});

test('reopening MoMo keeps the login the chat’s own menu picked; its model stays the brain’s (#2304)', async () => {
  const w = world({ prefs: { momo: { brain: { main: { harness: 'claude', account: 'du@work', model: 'opus' } } } } });
  const { chatId } = await w.svc.ensureMainChat();
  const told = w.changes.length;
  // the user picked another login in the chat's own menu; a window pushed a stale model
  w.claude.setOwn(chatId, { model: 'haiku', effort: null, account: 'du@home' });
  w.chats.patchMeta(chatId, { account: { id: 'du@home', pinned: true } });
  assert.deepEqual(await w.svc.ensureMainChat(), { chatId, warning: null });
  assert.equal(w.claude.own.get(chatId).account, 'du@home');
  assert.deepEqual(w.chats.records.get(chatId).meta.account, { id: 'du@home', pinned: true });
  // the model its turns run on is the brain's, in its file: nothing to change, nobody told
  assert.equal(w.chats.records.get(chatId).meta.momoModel, 'opus');
  assert.equal(w.changes.length, told);
});

test('the brain’s account must be signed in there and stay in its billing lane', async () => {
  const w = world({ prefs: { momo: { brain: { main: { harness: 'claude', account: 'du@work' } } } } });
  await w.svc.ensureMainChat();
  await assert.rejects(w.svc.setBrain({ harness: 'claude', account: 'nobody' }), {
    code: 'unknown_account',
    message: "That account isn't signed in on Claude Code.",
  });
  await assert.rejects(w.svc.setBrain({ harness: 'claude', account: 'du@api' }), { code: 'other_lane' });
  assert.equal(w.svc.getBrain().account, 'du@work');
  // another subscription is fine, and so is any account on another harness (its lane starts there)
  assert.equal((await w.svc.setBrain({ harness: 'claude', account: 'du@home' })).applied, 'now');
  assert.equal((await w.svc.setBrain({ harness: 'codex', account: 'cx-work', model: 'gpt-5' })).applied, 'nextMessage');
  // the brain's own harness had no account named: any lane
  const n = world({ prefs: { momo: { brain: { main: { harness: 'claude' } } } } });
  await n.svc.ensureMainChat();
  assert.equal((await n.svc.setBrain({ harness: 'claude', account: 'du@api' })).applied, 'now');
});

test('a brain change while a switch settles is refused, and the chat and the brain agree once it lands', async () => {
  const w = world();
  const { chatId } = await w.svc.ensureMainChat();
  await w.svc.setBrain({ harness: 'claude', model: 'sonnet' });
  // the next message starts: the controller marks the turn running and settleSwitch clears the chip before perform()
  w.state.patch(chatId, { turn: 'running', pendingSwitch: null });
  await assert.rejects(w.svc.setBrain({ harness: 'codex', model: 'gpt-5' }), { code: 'busy' });
  // perform() commits the Claude segment and the turn ends
  switched(w, chatId, 'claude', 'sess-1');
  w.state.patch(chatId, { turn: 'idle' });
  assert.equal(w.svc.getBrain().harness, 'claude');
  assert.deepEqual(await w.svc.ensureMainChat(), { chatId, warning: null });
  assert.equal(w.state.get(chatId).pendingSwitch, null);
  // now the user can go back
  assert.equal((await w.svc.setBrain({ harness: 'codex', model: 'gpt-5' })).applied, 'nextMessage');
});

test('#2276: a message that didn’t start isn’t work: the brain changes in place and the message goes with it', async () => {
  const w = world({ prefs: { momo: { brain: { main: { harness: 'codex', account: 'cx-work' } } } } });
  const { chatId } = await w.svc.ensureMainChat();
  // the first turn failed to start: its message waits first in the queue, nothing runs
  w.state.patch(chatId, { turn: 'crashed', queue: [{ id: 'q' }] });
  const now = await w.svc.setBrain({ harness: 'codex', account: 'cx-home', model: 'gpt-5' });
  assert.equal(now.applied, 'now');
  // not a turn: the account is pinned again too
  assert.equal(w.pool.pins.get(chatId), 'cx-home');
  const next = await w.svc.setBrain({ harness: 'claude', model: 'sonnet' });
  assert.equal(next.applied, 'nextMessage');
  assert.equal(w.state.get(chatId).pendingSwitch.harness, 'claude');
  assert.deepEqual(w.state.get(chatId).queue, [{ id: 'q' }]);
});

test('#2308: a Codex brain on an API key, named or the one in use, is refused before anything starts', async () => {
  const w = world();
  w.lanes['cx-key'] = 'apiKey';
  w.pool.known.add('cx-key');
  const { chatId } = await w.svc.ensureMainChat();
  await assert.rejects(w.svc.setBrain({ harness: 'codex', account: 'cx-key', model: 'gpt-5' }), {
    code: 'unsupported_account',
    message: 'MoMo needs a ChatGPT sign-in on Codex',
  });
  assert.equal(w.svc.getBrain().account, null);
  assert.equal(w.svc.mainChatId(), chatId);
  // no account named: the one Codex runs on now decides, for a new main chat and a background run alike
  const k = world();
  k.lanes['cx-key'] = 'apiKey';
  k.pool.active = () => ({ id: 'cx-key' });
  await assert.rejects(k.svc.ensureMainChat(), { code: 'unsupported_account' });
  await assert.rejects(k.svc.startBackground({ harness: 'codex' }, { momo: 'routine' }), { code: 'unsupported_account' });
  assert.equal(k.log.filter((e: any) => e[0] === 'codex').length, 0);
  // a ChatGPT sign-in in use, and other harnesses, start as before
  k.pool.active = () => ({ id: 'cx-work' });
  assert.ok((await k.svc.ensureMainChat()).chatId);
  assert.ok(await k.svc.startBackground({ harness: 'claude' }, { momo: 'routine' }));
});
