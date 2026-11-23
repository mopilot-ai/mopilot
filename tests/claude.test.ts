// The Claude adapter in main (electron/harness/claude/adapter.cjs): what a turn runs with, how it starts
// with no window, steers and stops, and the goal Sage keeps for Claude (pause, resume, round limit,
// the step after a crash). The SDK process is a fake; the session state is the real SessionStore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT, ref, tick, setup, item, msg, assistantText } from './support/claude-adapter.ts';
import { waitFor } from './support/waitFor.ts';

test("the Claude adapter's tool channel cancels each call itself, so a Stop doesn't abort the chat's other calls", () => {
  assert.equal(setup().adapter.cancelsToolCalls, true);
});

test('peer delivery preserves its journal identity and remains unattended in the target environment', async () => {
  const t = setup();
  const peer = { ...item('Peer request', { human: false }), peer: { messageId: 'peer-id', sourceChatId: 'other' } };
  const receipt = await t.adapter.startTurn(CHAT, ref(CHAT), peer, null);
  assert.equal(t.sent[0].meta.uuid, 'peer-id');
  assert.equal(t.sent[0].meta.human, false);
  assert.equal(t.sent[0].opts.cwd, '/from/transcript');
  assert.equal(receipt.turnId, 'ct-peer-id');
  assert.equal(receipt.itemId, 'peer-id');
});

test('a turn starts with no window: the settings come from the prefs, the message is built from what was typed', async () => {
  const t = setup({ prefs: { claudeSelection: { model: 'sonnet', effort: 'low', fast: false }, permission: 'auto-review' } });
  const r = await t.adapter.startTurn(CHAT, ref(CHAT), item('hello', { human: true }), null);
  assert.equal(r.started, true);
  assert.equal(r.turnId, `ct-${t.sent[0].meta.uuid}`);
  assert.equal(r.itemId, t.sent[0].meta.uuid);
  const s = t.sent[0];
  assert.equal(s.key, CHAT);
  assert.deepEqual(s.input, { text: 'hello', attachments: [] });
  assert.equal(s.opts.sessionId, 's1');
  assert.equal(s.opts.model, 'sonnet');
  assert.equal(s.opts.effort, 'low');
  // sonnet can't approve for me (D-67): the chat asks as usual
  assert.equal(s.opts.permission, 'default');
  assert.equal(s.opts.basePermission, 'auto-review');
  assert.equal(s.opts.bin, '/bin/claude');
  assert.equal(s.opts.account, 'default');
  assert.equal(s.meta.human, true);
  assert.deepEqual(t.kinds(), ['turnStarting', 'turnStarted']);
  // nothing named the session: it resumes, from its own folder
  assert.equal(s.opts.resume, true);
  assert.equal(s.opts.cwd, '/from/transcript');
  assert.equal(t.state.get(CHAT).modality, 'image');
});

test('a session a window just created starts, not resumes, with its folder; a side chat forks', async () => {
  const t = setup();
  t.adapter.registerSession(CHAT, { cwd: '/proj', ephemeral: true, forkFrom: 'src-1' });
  await t.adapter.startTurn(CHAT, ref(CHAT), item(), 7);
  const o = t.sent[0].opts;
  assert.equal(o.resume, false);
  assert.equal(o.cwd, '/proj');
  assert.equal(o.ephemeral, true);
  assert.equal(o.forkFrom, 'src-1');
  // the second message resumes it: the session exists now
  await t.adapter.startTurn(CHAT, ref(CHAT), item('again'), 7);
  assert.equal(t.sent[1].opts.resume, true);
  assert.equal(t.sent[1].opts.forkFrom, undefined);
});

test('events go to the window the message came from, in order', async () => {
  const t = setup();
  await t.adapter.startTurn(
    CHAT,
    ref(CHAT),
    { text: 'a', attachments: [{ kind: 'file', path: '/x', previewUrl: 'blob:1' }], opts: { note: { kind: 'switch', text: 'n' } } },
    7,
  );
  const [starting, started] = t.events;
  assert.equal(starting[1], 7);
  assert.equal(starting[0].kind, 'turnStarting');
  assert.equal(starting[0].text, 'a');
  // the window shows what it sent, previews included; main sends the CLI none
  assert.equal(starting[0].attachments[0].previewUrl, 'blob:1');
  assert.equal(t.sent[0].input.attachments[0].previewUrl, undefined);
  assert.match(starting[0].turnId, /^ct-/);
  assert.equal(started[0].clientId, starting[0].clientId);
  assert.equal(t.sent[0].meta.uuid, starting[0].clientId);
  assert.equal(started[0].want.account, 'default');
  // a turn nobody sent from (a queue drained after its window closed) goes to any window
  const u = setup();
  await u.adapter.startTurn(CHAT, ref(CHAT), item(), null);
  assert.equal(u.events[0][1], 'any');
});

test("the chat's own pick wins over the defaults, and a scheduled task's over both", async () => {
  const t = setup({ prefs: { claudeSelection: { model: 'opus', effort: 'high', fast: false } } });
  t.adapter.setOwn(CHAT, { model: 'sonnet', effort: null, account: null });
  await t.adapter.startTurn(CHAT, ref(CHAT), item(), null);
  assert.equal(t.sent[0].opts.model, 'sonnet');
  // the chat didn't pick an effort: the default one stays
  assert.equal(t.sent[0].opts.effort, 'high');
  await t.adapter.startTurn(CHAT, ref(CHAT), item('x', { model: 'opus', effort: 'low' }), null);
  assert.equal(t.sent[1].opts.model, 'opus');
  assert.equal(t.sent[1].opts.effort, 'low');
  t.adapter.setOwn(CHAT, null);
  await t.adapter.startTurn(CHAT, ref(CHAT), item(), null);
  assert.equal(t.sent[2].opts.model, 'opus');
});

test('plan mode: the turn runs in plan, whatever the permission pref', async () => {
  const t = setup({ prefs: { permission: 'full-access' } });
  await t.adapter.startTurn(CHAT, ref(CHAT), item('plan it', { plan: true }), null);
  assert.equal(t.sent[0].opts.permission, 'plan');
  assert.equal(t.sent[0].opts.basePermission, 'full-access');
});

test('a live session is brought in line in place; another account restarts it, so nothing is applied', async () => {
  const t = setup({ prefs: { claudeSelection: { model: 'opus', effort: 'high', fast: false } } });
  await t.adapter.startTurn(CHAT, ref(CHAT), item(), null);
  assert.deepEqual(t.controls, []);
  t.setPrefs({ claudeSelection: { model: 'sonnet', effort: 'high', fast: false }, permission: 'read-only' });
  await t.adapter.startTurn(CHAT, ref(CHAT), item(), null);
  assert.deepEqual(t.controls, [
    [CHAT, 'setModel', 'sonnet'],
    [CHAT, 'setPermissionMode', 'read-only'],
  ]);
  // the login moved: the process is replaced, so the old settings are not applied
  t.adapter.setOwn(CHAT, { model: null, effort: null, account: 'work' });
  const u = setup({
    accounts: {
      active: 'default',
      accounts: [
        { id: 'default', loggedIn: true },
        { id: 'work', loggedIn: true },
      ],
    },
  });
  await u.adapter.startTurn(CHAT, ref(CHAT), item(), null);
  u.adapter.setOwn(CHAT, { model: 'sonnet', effort: null, account: 'work' });
  await u.adapter.startTurn(CHAT, ref(CHAT), item(), null);
  assert.deepEqual(u.controls, []);
  assert.equal(u.sent[1].opts.account, 'work');
  // a process that is gone has nothing to apply either
  u.live.clear();
  u.adapter.setOwn(CHAT, { model: 'opus', effort: null, account: 'work' });
  await u.adapter.startTurn(CHAT, ref(CHAT), item(), null);
  assert.deepEqual(u.controls, []);
});

test('a login the chat was on that is signed out is not used', () => {
  const t = setup({
    accounts: {
      active: 'default',
      accounts: [
        { id: 'default', loggedIn: true },
        { id: 'old', loggedIn: false },
      ],
    },
  });
  t.adapter.setOwn(CHAT, { model: null, effort: null, account: 'old' });
  assert.equal(t.adapter.accountOf(CHAT), 'default');
  t.adapter.setOwn(CHAT, { model: null, effort: null, account: 'default' });
  assert.equal(t.adapter.accountOf(CHAT), 'default');
});

test('a turn that could not start tells the window, and says it did not start', async () => {
  const t = setup({ failSend: true });
  const r = await t.adapter.startTurn(CHAT, ref(CHAT), item(), 3);
  assert.deepEqual(r, { started: false, error: 'Claude Code is not installed' });
  assert.deepEqual([...t.kinds(), t.events[0][0].itemId], ['turnStarting', 'turnFailed', 'q-hi']); // itemId: the send shown early
  assert.equal(t.events[1][0].error, 'Claude Code is not installed');
  assert.equal(t.events[1][1], 3);
});

test('a steer goes into the running turn; without a live session it is a turn of its own', async () => {
  const t = setup();
  const lone = await t.adapter.steer(CHAT, ref(CHAT), item('now'), 1);
  assert.equal(lone.started, true);
  assert.equal(lone.turnId, `ct-${t.sent[0].meta.uuid}`);
  assert.equal(t.sent[0].priority, undefined);
  const r = await t.adapter.steer(CHAT, ref(CHAT), item('more', { human: true }), 1);
  assert.deepEqual(r, { started: true });
  assert.equal(t.sent[1].priority, 'now');
  assert.equal(t.sent[1].meta.human, true);
  assert.equal(t.events.at(-1)![0].kind, 'steered');
});

test('a steer is shown before it goes to the CLI, so its reply cannot overtake it', async () => {
  const t = setup();
  await t.adapter.startTurn(CHAT, ref(CHAT), item('first'), 1);
  // what the windows had been told when the message reached the CLI: send() resolves only after a process
  // scan, by when the CLI may have finished the turn and answered the steer
  let toldBeforeSend: string[] = [];
  const send = t.adapter.sendTo;
  t.adapter.sendTo = (...a: any[]) => ((toldBeforeSend = t.kinds()), send(...a));
  await t.adapter.steer(CHAT, ref(CHAT), item('more'), 1);
  assert.equal(toldBeforeSend.at(-1), 'steered');
  assert.equal(t.events.at(-1)![0].clientId, t.sent[1].meta.uuid);
});

test('peer steer retains stable input identity and never marks the receiving turn human', async () => {
  const t = setup();
  await t.adapter.startTurn(CHAT, ref(CHAT), item('Existing task'), 1);
  t.state.patch(CHAT, { turn: 'running', activeTurn: { id: 'existing-turn', human: false } });
  const peer = { ...item('Peer request'), peer: { messageId: 'peer-steer', sourceChatId: 'source' } };
  const r = await t.adapter.steer(CHAT, ref(CHAT), peer, null);
  assert.deepEqual(r, { started: true, turnId: 'existing-turn', itemId: 'peer-steer' });
  assert.equal(t.sent[1].meta.uuid, 'peer-steer');
  assert.equal(t.sent[1].meta.human, false);
  assert.equal(t.sent[1].priority, 'now');
  assert.equal(t.events.at(-1)![0].clientId, 'peer-steer');
});

test('a peer steer into a turn whose id is not yet known reports a null turn id', async () => {
  const t = setup();
  await t.adapter.startTurn(CHAT, ref(CHAT), item('Existing task'), 1);
  t.state.patch(CHAT, { turn: 'running', activeTurn: null });
  const peer = { ...item('Peer request'), peer: { messageId: 'peer-early', sourceChatId: 'source' } };
  assert.deepEqual(await t.adapter.steer(CHAT, ref(CHAT), peer, null), { started: true, turnId: null, itemId: 'peer-early' });
});

test('stop interrupts; windows mark their open turn first', async () => {
  const t = setup();
  await t.adapter.startTurn(CHAT, ref(CHAT), item(), 1);
  await t.adapter.stop(CHAT);
  assert.equal(t.events.at(-1)![0].kind, 'interrupting');
  assert.deepEqual(t.interrupted, [CHAT]);
  assert.deepEqual(t.controls.at(-1), [CHAT, 'interrupt', undefined]);
});

/* ---- goals ---- */
test('goal: "Goal set" starts it, each Stop hook check counts a round, and the loop ending settles it from the transcript', async () => {
  const check = { type: 'user', message: { content: [{ type: 'text', text: 'Stop hook feedback:\n[tests pass]: not yet' }] } };
  const t = setup({ goalText: JSON.stringify({ attachment: { type: 'goal_status', met: true, condition: 'tests pass' } }) });
  t.adapter.observe(assistantText('Goal set: tests pass'));
  assert.equal(t.state.get(CHAT).goal.status, 'active');
  assert.equal(t.state.get(CHAT).goal.claude.limit, null);
  t.adapter.observe({ key: CHAT, kind: 'message', msg: check });
  assert.equal(t.state.get(CHAT).goal.claude.iterations, 1);
  t.adapter.observe(msg('result', { subtype: 'success' }));
  await tick();
  await tick();
  assert.equal(t.state.get(CHAT).goal.status, 'complete');
  assert.deepEqual(
    t.notices.map((n) => n.status),
    ['complete'],
  );
});

test('goal: a loop that ends unmet is stopped; an API key puts a round limit on it', async () => {
  const t = setup({ metered: true });
  t.adapter.observe(assistantText('Goal set: ship'));
  assert.equal(t.state.get(CHAT).goal.claude.limit, 30);
  t.adapter.observe(msg('result', { subtype: 'success' }));
  // the unmet read is retried after 400 ms, which starts only once the grace timer ran: wait for the result rather
  // than a fixed time a busy machine can outlast
  await waitFor(() => !(t.state.get(CHAT).goal.status === 'active'), 'the goal to stop being active');
  assert.equal(t.state.get(CHAT).goal.status, 'stopped');
});

test('goal: the round limit pauses it (budgetLimited) after stopping the loop', async () => {
  const t = setup({ metered: true });
  t.adapter.observe(assistantText('Goal set: ship'));
  t.state.patch(CHAT, { turn: 'running' });
  const check = { type: 'user', message: { content: [{ type: 'text', text: 'Stop hook feedback:\n[ship]: no' }] } };
  for (let i = 0; i < 30; i++) t.adapter.observe({ key: CHAT, kind: 'message', msg: check });
  await tick();
  assert.equal(t.state.get(CHAT).goal.status, 'budgetLimited');
  assert.equal(
    t.events.some(([e]) => e.kind === 'interrupting'),
    true,
  );
  // the loop ends: the CLI's goal is cleared by Sage's own message
  t.state.patch(CHAT, { turn: 'idle' });
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(
    t.enqueued.map((e) => e.item.text),
    ['/goal clear'],
  );
  assert.deepEqual(t.enqueued[0].item.opts, { goalClear: true });
});

test("goal: pause stops the loop then clears the CLI's goal, and resume sends the condition again", async () => {
  const t = setup();
  t.adapter.observe(assistantText('Goal set: ship'));
  await t.adapter.pauseGoal(CHAT);
  assert.equal(t.state.get(CHAT).goal.status, 'paused');
  assert.deepEqual(
    t.enqueued.map((e) => e.item.text),
    ['/goal clear'],
  );
  assert.deepEqual(t.notices, [], 'a pause the user asked for is not news');
  await t.adapter.resumeGoal(CHAT);
  assert.equal(t.state.get(CHAT).goal.status, 'active');
  assert.equal(t.state.get(CHAT).goal.claude.iterations, 0);
  assert.equal(t.enqueued.at(-1)!.item.text, '/goal ship');
});

test('goal: Stop on a chat with an active goal pauses it, otherwise only interrupts', async () => {
  const t = setup();
  await t.adapter.stop(CHAT);
  assert.deepEqual(t.enqueued, [] as any[]);
  t.adapter.observe(assistantText('Goal set: ship'));
  await t.adapter.stop(CHAT);
  assert.equal(t.state.get(CHAT).goal.status, 'paused');
  assert.deepEqual(
    t.enqueued.map((e) => e.item.text),
    ['/goal clear'],
  );
});

test('goal: clear forgets the condition; a "/goal clear" the user typed keeps origin human', async () => {
  const t = setup();
  t.adapter.observe(assistantText('Goal set: ship'));
  await t.adapter.clearGoal(CHAT, true);
  assert.equal(t.state.get(CHAT).goal, null);
  assert.deepEqual(
    t.enqueued.map((e) => [e.item.text, e.item.opts]),
    [['/goal clear', { human: true, goalClear: true }]],
  );
});

test("goal: a crash holds an active goal, and Resume then clears the CLI's goal before setting it again", async () => {
  const t = setup();
  t.adapter.observe(assistantText('Goal set: ship'));
  t.adapter.crashed(CHAT);
  assert.equal(t.state.get(CHAT).goal.status, 'paused');
  await t.adapter.resumeGoal(CHAT);
  assert.deepEqual(
    t.enqueued.map((e) => e.item.text),
    ['/goal clear', '/goal ship'],
  );
  // once: the next resume has nothing to clear
  t.state.patch(CHAT, { goal: { ...t.state.get(CHAT).goal, status: 'paused' } });
  await t.adapter.resumeGoal(CHAT);
  assert.deepEqual(
    t.enqueued.slice(2).map((e) => e.item.text),
    ['/goal ship'],
  );
});

test('goal: a turn that ends on a usage limit hands its goal to the next login: it is not settled', async () => {
  const t = setup({ goalText: null });
  t.adapter.observe(assistantText('Goal set: ship'));
  t.adapter.setHandover(CHAT, true);
  t.adapter.observe(msg('result', { subtype: 'success' }));
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(t.state.get(CHAT).goal.status, 'active');
  // a window that decides just after the result still stops it
  const u = setup({ goalText: null });
  u.adapter.observe(assistantText('Goal set: ship'));
  u.adapter.observe(msg('result', { subtype: 'success' }));
  u.adapter.setHandover(CHAT, true);
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(u.state.get(CHAT).goal.status, 'active');
});

test('a goal from the CLI that Sage is holding (paused) stays held when the CLI reports it cleared', () => {
  const t = setup();
  t.adapter.observe(assistantText('Goal set: ship'));
  t.state.patch(CHAT, { goal: { ...t.state.get(CHAT).goal, status: 'paused' } });
  t.adapter.observe({ key: CHAT, kind: 'message', msg: { type: 'system', subtype: 'local_command_output', content: 'Goal cleared' } });
  assert.equal(t.state.get(CHAT).goal.status, 'paused');
});

test('the live settings are dropped when the process ends', async () => {
  const t = setup({ prefs: { claudeSelection: { model: 'opus', effort: null, fast: false } } });
  await t.adapter.startTurn(CHAT, ref(CHAT), item(), null);
  assert.equal(t.adapter.live.has(CHAT), true);
  t.adapter.observe({ key: CHAT, kind: 'closed' });
  assert.equal(t.adapter.live.has(CHAT), false);
});

test('a permission change reaches live CLIs at once, except plan and read-only moves', async () => {
  const t = setup({ prefs: { claudeSelection: { model: 'opus', effort: null, fast: false } } });
  const OTHER = 'claude:s2';
  const PLAN = 'claude:s3';
  const GONE = 'claude:s4';
  await t.adapter.startTurn(CHAT, ref(CHAT), item(), null);
  await t.adapter.startTurn(OTHER, ref(OTHER), item(), null);
  await t.adapter.startTurn(PLAN, ref(PLAN), item('plan it', { plan: true }), null);
  await t.adapter.startTurn(GONE, ref(GONE), item(), null);
  t.live.delete(GONE);
  // nothing changed
  assert.deepEqual(await t.adapter.permissionChanged(), []);
  // Full access: the live CLIs take bypassPermissions now (one refuses); plan and a CLI that is gone are left alone
  t.setPrefs({ permission: 'full-access' });
  const control = t.api.control;
  t.api.control = async (k: string, m: string, a?: unknown) => {
    if (k === OTHER) throw new Error('Query closed');
    return control(k, m, a);
  };
  assert.deepEqual(await t.adapter.permissionChanged(), [CHAT]);
  assert.deepEqual(t.controls, [[CHAT, 'setPermissionMode', 'full-access']]);
  assert.equal(t.adapter.live.get(CHAT).permission, 'full-access');
  assert.equal(t.adapter.live.get(OTHER).permission, 'default', 'a CLI that refused keeps its mode for its next turn to set');
  assert.equal(t.adapter.live.get(PLAN).permission, 'plan');
  t.api.control = control;
  // the chat's next turn has nothing left to apply
  await t.adapter.startTurn(CHAT, ref(CHAT), item(), null);
  assert.deepEqual(t.controls, [[CHAT, 'setPermissionMode', 'full-access']]);
  // a move into read-only restarts the CLI at its next turn instead; so does a move out of it
  t.setPrefs({ permission: 'read-only' });
  assert.deepEqual(await t.adapter.permissionChanged(), []);
  await t.adapter.startTurn(CHAT, ref(CHAT), item(), null);
  t.setPrefs({ permission: 'auto-review' });
  assert.deepEqual(await t.adapter.permissionChanged(), [OTHER]);
  assert.equal(t.adapter.live.get(CHAT).permission, 'read-only');
  assert.equal(t.adapter.live.get(OTHER).permission, 'auto-review');
});
