// electron/platform/exitGate.cjs and electron/updates/updater.cjs's policy: what quitting would stop, the
// dialog's wording, when to ask, pausing goals on confirm; silent scheduled update checks (D-77..79).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ExitGate,
  createExitGate,
  holdQuit,
  summarize,
  summaryText,
  needsConfirm,
  isEmpty,
  codexBackground,
} = require('../electron/platform/exitGate.cjs');
const { prefsChanged, checkPlan } = require('../electron/updates/updater.cjs');
const { developerIdTeamOf } = require('../electron/updates/signature.cjs');

const states: Record<string, any> = {
  a: { turn: 'running', goal: { status: 'active', objective: 'tests pass' } },
  b: { turn: 'awaitingUser', goal: null },
  c: { turn: 'idle', goal: { status: 'active', objective: 'ship it' } },
  d: { turn: 'idle', goal: { status: 'paused', objective: 'later' } },
};
const kinds: Record<string, string> = { a: 'codex', b: 'codex', c: 'claude', d: 'claude' };
const sum = () =>
  summarize({ chats: Object.keys(states), get: (id: string) => states[id], kindOf: (id: string) => kinds[id], background: 2 });

test('summary: running and waiting turns, background tasks, active goals by harness', () => {
  assert.deepEqual(sum(), {
    turns: ['a', 'b'],
    background: 2,
    goals: [
      { chatId: 'a', kind: 'codex', objective: 'tests pass' },
      { chatId: 'c', kind: 'claude', objective: 'ship it' },
    ],
  });
  assert.equal(isEmpty(summarize({ chats: ['d'], get: (id: string) => states[id], kindOf: () => 'claude' })), true);
});

test('wording: what will stop, and what is running', () => {
  assert.equal(summaryText(sum()), '2 turns, 2 background tasks and 2 goals will stop. Goals are paused, not lost.');
  assert.equal(summaryText({ turns: ['a'], background: 0, goals: [{}] }), '1 turn and 1 goal will stop. Goals are paused, not lost.');
  assert.equal(summaryText({ turns: ['a'], background: 0, goals: [] }), '1 turn will stop.');
  assert.equal(summaryText({ turns: [], background: 0, goals: [] }), '');
});

test('confirmClose: never skips the dialog, always asks, the default asks when work would stop', () => {
  const empty = { turns: [], background: 0, goals: [] };
  assert.equal(needsConfirm(sum(), 'never'), false);
  assert.equal(needsConfirm(empty, 'always'), true);
  assert.equal(needsConfirm(empty, 'shortcut'), false);
  assert.equal(needsConfirm(sum(), 'shortcut'), true);
  assert.equal(needsConfirm(sum(), undefined), true);
});

function gate(answer: boolean, confirmClose = 'shortcut', s = sum()) {
  const calls: string[] = [];
  const g = new ExitGate({
    collect: async () => s,
    confirmClose: () => confirmClose,
    confirm: async (_s: any, reason: string) => (calls.push(`confirm:${reason}`), answer),
    pauseCodex: async (goals: any[]) => calls.push(`codex:${goals.map((x) => x.chatId)}`),
    pauseClaude: async (goals: any[]) => calls.push(`claude:${goals.map((x) => x.chatId)}`),
  });
  return { g, calls };
}

test('gate: Cancel keeps the app and pauses nothing', async () => {
  const { g, calls } = gate(false);
  assert.equal(await g.request('quit'), false);
  assert.equal(g.passed, false);
  assert.deepEqual(calls, ['confirm:quit']);
});

test('gate: confirm pauses Codex and Claude goals, then lets the exit through once', async () => {
  const { g, calls } = gate(true);
  assert.equal(await g.request('update'), true);
  assert.equal(g.passed, true);
  assert.deepEqual(calls, ['confirm:update', 'codex:a', 'claude:c']);
  assert.equal(await g.request('quit'), true);
  assert.equal(calls.length, 3);
});

test('gate: confirmClose never still pauses goals; nothing running asks nothing', async () => {
  const never = gate(false, 'never');
  assert.equal(await never.g.request('quit'), true);
  assert.deepEqual(never.calls, ['codex:a', 'claude:c']);
  const idle = gate(false, 'shortcut', { turns: [], background: 0, goals: [] });
  assert.equal(await idle.g.request('quit'), true);
  assert.deepEqual(idle.calls, []);
});

test('gate: a second request while the dialog is up gets the same answer', async () => {
  let release: (v: boolean) => void = () => {};
  let asked = 0;
  const g = new ExitGate({
    collect: async () => sum(),
    confirmClose: () => 'shortcut',
    confirm: () => (asked++, new Promise((r) => (release = r))),
    pauseCodex: async () => {},
    pauseClaude: async () => {},
  });
  const one = g.request('quit');
  const two = g.request('quit');
  await new Promise((r) => setImmediate(r));
  release(true);
  assert.deepEqual(await Promise.all([one, two]), [true, true]);
  assert.equal(asked, 1);
});

test("createExitGate: with no window open, Claude goals are paused by main's adapter directly", async () => {
  const paused: string[] = [];
  const g = createExitGate({
    ipcMain: { on() {}, removeListener() {}, once() {} },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    window: () => null,
    sessions: () => ({ all: () => Object.keys(states), get: (id: string) => states[id] }),
    controller: () => ({ ref: (id: string) => ({ kind: kinds[id], key: id }) }),
    codex: () => null,
    claude: () => null,
    claudeTurns: () => ({ goalAction: async (id: string, action: string) => void paused.push(`${id}:${action}`) }),
    prefs: () => ({ confirmClose: 'never' }),
  });
  assert.equal(await g.request('quit'), true);
  assert.deepEqual(paused, ['c:pause']);
});

test('createExitGate: a Claude pause that rejects does not hold the exit', async () => {
  const g = createExitGate({
    ipcMain: {},
    dialog: {},
    window: () => null,
    sessions: () => ({ all: () => ['c'], get: (id: string) => states[id] }),
    controller: () => ({ ref: () => ({ kind: 'claude', key: 'c' }) }),
    codex: () => null,
    claude: () => null,
    claudeTurns: () => ({ goalAction: async () => Promise.reject(new Error('gone')) }),
    prefs: () => ({ confirmClose: 'never' }),
  });
  assert.equal(await g.request('quit'), true);
});

test('gate: a pause that hangs holds the exit only so long', async () => {
  const g = new ExitGate({
    collect: async () => sum(),
    confirmClose: () => 'never',
    confirm: async () => true,
    pauseCodex: () => new Promise(() => {}),
    pauseClaude: async () => {},
    pauseMs: 20,
  });
  assert.equal(await g.request('quit'), true);
});

test('gate: pauses that fail do not stop the quit', async () => {
  const paused: string[] = [];
  const g = new ExitGate({
    collect: async () => sum(),
    confirmClose: () => 'never',
    confirm: async () => true,
    pauseCodex: async () => {
      paused.push('codex');
      throw new Error('app-server gone');
    },
    pauseClaude: () => {
      paused.push('claude');
      return Promise.reject(new Error('CLI gone'));
    },
  });
  assert.equal(await g.request('quit'), true);
  assert.deepEqual(paused, ['codex', 'claude']);
});

test('background: Codex background terminals over loaded threads', async () => {
  const codex = {
    leases: new Map([
      ['t1', {}],
      ['t2', {}],
    ]),
    request: async (_m: string, p: any) => ({ data: p.threadId === 't1' ? [1, 2] : [] }),
  };
  assert.equal(await codexBackground(codex), 2);
  assert.equal(await codexBackground(null), 0);
  assert.equal(await codexBackground({ leases: new Map([['t', {}]]), request: () => new Promise(() => {}) }, 10), 0);
});

test('updater: Developer ID team from codesign, schedule only on a change, silent scheduled checks outside /Applications', () => {
  const devId = 'Authority=Developer ID Application: MoPilot LLC (AB12CD34EF)\nAuthority=Developer ID Certification Authority\n';
  assert.equal(developerIdTeamOf(`Identifier=ai.mopilot.code\n${devId}TeamIdentifier=AB12CD34EF\n`), 'AB12CD34EF');
  assert.equal(developerIdTeamOf(`${devId}TeamIdentifier=not set\n`), null);
  assert.equal(developerIdTeamOf('Identifier=ai.mopilot.code\nTeamIdentifier=AB12CD34EF\n'), null, 'no leaf authority: not a release');
  assert.equal(developerIdTeamOf('Authority=Apple Development: Dev (29RC33CGL6)\nTeamIdentifier=TEAM123456\n'), null);
  assert.equal(
    developerIdTeamOf('Authority=Apple Development: Dev (X)\nAuthority=Developer ID Application: Other (Y)\nTeamIdentifier=Y\n'),
    null,
    'only the leaf counts',
  );
  assert.equal(developerIdTeamOf(''), null);
  assert.equal(prefsChanged(null, { auto: true, channel: 'stable' }), true);
  assert.equal(prefsChanged({ auto: true, channel: 'stable' }, { auto: true, channel: 'stable' }), false);
  assert.equal(prefsChanged({ auto: true, channel: 'stable' }, { auto: true, channel: 'beta' }), true);
  assert.equal(prefsChanged({ auto: true, channel: 'beta' }, { auto: false, channel: 'beta' }), true);
  assert.equal(checkPlan({ manual: false, inApplications: true, declinedMove: false }), 'check');
  assert.equal(checkPlan({ manual: false, inApplications: false, declinedMove: false }), 'skip');
  assert.equal(checkPlan({ manual: true, inApplications: false, declinedMove: false }), 'ask-move');
  assert.equal(checkPlan({ manual: true, inApplications: false, declinedMove: true }), 'blocked');
});

test('Claude background work counts: workflows, monitors and /loop wake-ups, not ambient housekeeping', () => {
  const { claudeBackground } = require('../electron/platform/exitGate.cjs');
  const tasks = [
    { id: 'w', type: 'local_workflow', ambient: false },
    { id: 'm', type: 'monitor', ambient: true },
    { id: 'h', type: 'local_agent', ambient: true },
  ];
  assert.equal(claudeBackground(tasks), 2);
  assert.equal(claudeBackground(undefined), 0);
  const st: Record<string, any> = { a: { turn: 'idle', tasks, goal: null }, b: { turn: 'idle', tasks: [], goal: null } };
  const s = summarize({
    chats: ['a', 'b'],
    get: (id: string) => st[id],
    kindOf: () => 'claude',
    background: 1,
    loops: (id: string) => (id === 'b' ? 2 : 0),
  });
  assert.equal(s.background, 5);
  assert.equal(summaryText(s), '5 background tasks will stop.');
});

test('goalHeld: a paused Claude goal is kept and comes back paused; other states keep nothing', () => {
  const { heldOf, restoreGoal } = require('../electron/session/goalHeld.cjs');
  const goal = { objective: ' all tests pass ', status: 'paused', updatedAt: 5, claude: { iterations: 3, lastReason: 'x', limit: 30 } };
  const held = heldOf(goal);
  assert.deepEqual(held, { objective: 'all tests pass', status: 'paused', limit: 30, at: 5 });
  const back = restoreGoal(held, 'c1', 9);
  assert.equal(back.status, 'paused');
  assert.equal(back.objective, 'all tests pass');
  assert.equal(back.claude.iterations, 0);
  assert.equal(back.claude.limit, 30);
  assert.equal(heldOf({ ...goal, status: 'budgetLimited' })?.status, 'budgetLimited');
  assert.equal(heldOf({ ...goal, status: 'active' }), null);
  assert.equal(heldOf({ ...goal, status: 'complete' }), null);
  assert.equal(heldOf(null), null);
  assert.equal(restoreGoal({}, 'c1'), null);
});

test('holdQuit: lets the quit through with no gate or once the gate passed', () => {
  let prevented = 0;
  const e = { preventDefault: () => prevented++ };
  assert.equal(
    holdQuit(e, undefined, () => assert.fail('quit')),
    false,
  );
  assert.equal(
    holdQuit(e, { passed: true }, () => assert.fail('quit')),
    false,
  );
  assert.equal(prevented, 0);
});

test('holdQuit: holds the quit, then quits again in a later task once the gate passes (SIGTERM)', async () => {
  // a native quit (SIGTERM) runs microtasks while before-quit is emitted: quitting again from one of them
  // would be overwritten as cancelled, so the second quit must wait for a later task
  let prevented = 0;
  let quits = 0;
  const e = { preventDefault: () => prevented++ };
  const gate = { passed: false, request: (reason: string) => (assert.equal(reason, 'quit'), Promise.resolve(true)) };
  assert.equal(
    holdQuit(e, gate, () => quits++),
    true,
  );
  assert.equal(prevented, 1);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(quits, 0, 'not from a microtask');
  await new Promise((r) => setImmediate(r));
  assert.equal(quits, 1);
});

test('holdQuit: the user keeping the app open cancels the quit', async () => {
  const deferred: Array<() => void> = [];
  const e = { preventDefault: () => {} };
  assert.equal(
    holdQuit(
      e,
      { passed: false, request: () => Promise.resolve(false) },
      () => assert.fail('quit'),
      (fn: () => void) => deferred.push(fn),
    ),
    true,
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(deferred.length, 0);
});

test('gate: synchronous pause failures do not prevent quitting or pausing the other harness', async () => {
  for (const failing of ['codex', 'claude']) {
    const paused: string[] = [];
    const g = new ExitGate({
      collect: async () => sum(),
      confirmClose: () => 'never',
      pauseCodex: () => {
        paused.push('codex');
        if (failing === 'codex') throw new Error('app-server gone');
      },
      pauseClaude: () => {
        paused.push('claude');
        if (failing === 'claude') throw new Error('CLI gone');
      },
    });
    assert.equal(await g.request('quit'), true);
    assert.equal(g.passed, true);
    assert.deepEqual(paused, ['codex', 'claude']);
  }
});

test('createExitGate: a synchronous per-chat pause failure does not skip later goals', async () => {
  const paused: string[] = [];
  const chats = ['codex-a', 'codex-b', 'claude-a', 'claude-b'];
  const pause = (id: string) => {
    paused.push(id);
    if (id.endsWith('-a')) throw new Error('chat gone');
    return Promise.resolve();
  };
  const g = createExitGate({
    ipcMain: {},
    dialog: {},
    window: () => null,
    sessions: () => ({ all: () => chats, get: () => ({ turn: 'idle', goal: { status: 'active', objective: 'work' } }) }),
    controller: () => ({ ref: (id: string) => ({ kind: id.split('-')[0], key: id }) }),
    codex: () => ({ leased: pause }),
    claude: () => null,
    claudeTurns: () => ({ goalAction: pause }),
    prefs: () => ({ confirmClose: 'never' }),
  });
  assert.equal(await g.request('quit'), true);
  assert.deepEqual(paused, chats);
});

test('gate: a confirmation that cannot be asked tells the user and lets the asked-for quit through', async () => {
  const told: any[] = [];
  const paused: string[] = [];
  const g = new ExitGate({
    collect: async () => sum(),
    confirmClose: () => 'shortcut',
    confirm: async () => {
      throw new Error('renderer gone');
    },
    confirmFailed: (error: Error, reason: string) => told.push([error.message, reason]),
    pauseCodex: async () => paused.push('codex'),
    pauseClaude: async () => paused.push('claude'),
  });
  assert.equal(await g.request('quit'), true);
  assert.equal(g.passed, true);
  assert.deepEqual(told, [['renderer gone', 'quit']]);
  assert.deepEqual(paused, ['codex', 'claude']);
});

test('gate: telling the user about a failed confirmation may fail too, and quitting still does not hang', async () => {
  const { clearIgnored, recentIgnored } = require('../electron/ignored.cjs');
  clearIgnored();
  const failing = new ExitGate({
    collect: async () => sum(),
    confirmClose: () => 'always',
    confirm: () => Promise.reject(new Error('no dialog')),
    confirmFailed: () => {
      throw new Error('no error box either');
    },
  });
  assert.equal(await failing.request('update'), true);
  assert.deepEqual(
    recentIgnored().map((e: any) => [e.context, e.message]),
    [['tell the user the quit confirmation failed', 'no error box either']],
  );
  const silent = new ExitGate({ collect: async () => sum(), confirmClose: () => 'always', confirm: () => Promise.reject(new Error('x')) });
  assert.equal(await silent.request('quit'), true);
});

test('gate: when what would stop cannot be counted, it asks anyway, says so, and Codex still pauses its goals', async () => {
  const asked: any[] = [];
  const paused: any[] = [];
  const make = (confirmClose: string) =>
    new ExitGate({
      collect: () => Promise.reject(new Error('sessions gone')),
      confirmClose: () => confirmClose,
      confirm: async (s: any) => (asked.push(summaryText(s)), false),
      pauseCodex: async (goals: any[]) => paused.push(['codex', goals]),
      pauseClaude: async (goals: any[]) => paused.push(['claude', goals]),
    });
  assert.equal(await make('shortcut').request('quit'), false);
  assert.deepEqual(asked, ["MoPilot couldn't check what is still running."]);
  assert.deepEqual(paused, []);
  assert.equal(await make('never').request('quit'), true);
  assert.equal(asked.length, 1);
  // the Claude goals can't be known without the sessions; Codex pauses all of its active goals itself
  assert.deepEqual(paused, [['codex', []]]);
  assert.equal(needsConfirm({ turns: [], background: 0, goals: [], unknown: true }, 'shortcut'), true);
});

test('gate: failed goal pauses are recorded with what was being paused', async () => {
  const { clearIgnored, recentIgnored } = require('../electron/ignored.cjs');
  clearIgnored();
  const g = new ExitGate({
    collect: async () => sum(),
    confirmClose: () => 'never',
    confirm: async () => true,
    pauseCodex: () => Promise.reject(new Error('app-server gone')),
    pauseClaude: () => Promise.reject(new Error('CLI gone')),
  });
  assert.equal(await g.request('quit'), true);
  assert.deepEqual(
    recentIgnored().map((e: any) => [e.context, e.message]),
    [
      ['pause the Codex goals before quitting', 'app-server gone'],
      ['pause the Claude goals before quitting', 'CLI gone'],
    ],
  );
});
