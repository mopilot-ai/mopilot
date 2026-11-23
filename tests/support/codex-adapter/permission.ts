// Codex adapter cases: a run Codex starts on the thread's own settings (a goal, a review) runs with the chat's permission.
import { test, assert, setup, require } from './fixture.ts';

const { windowRequest } = require('../../../electron/harness/codexApi.cjs');

const goalAnswer = (p: any) => ({ goal: { threadId: p.threadId, objective: p.objective ?? 'ship', status: p.status } });
const FULL = { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' } };
const sentOf = (server: any, method: string) => server.sent.filter((m: any) => m.method === method).map((m: any) => m.params);

export function registerGoalPermission() {
  test("startGoal: the chat's permission is applied to the thread before thread/goal/set starts its turn", async () => {
    const { a, server, state } = setup(
      { 'thread/goal/set': goalAnswer },
      { segments: { chat1: 'seg2' }, config: { chat1: { permission: 'full-access' } } },
    );
    const res = await a.startGoal('chat1', { kind: 'codex', id: 'seg2' }, { text: '', attachments: [], opts: { goal: 'ship' } }, 1);
    assert.deepEqual(res, { started: true });
    const methods = server.methods();
    assert.ok(methods.indexOf('thread/settings/update') < methods.indexOf('thread/goal/set'));
    // a resumed thread falls back to Codex's default sandbox, so the goal's turns would otherwise run on that
    assert.deepEqual(sentOf(server, 'thread/settings/update'), [{ threadId: 'seg2', ...FULL }]);
    // computer use's authorization anchor follows the permission the goal runs with, as a turn's does
    assert.equal(state.get('chat1').permission, 'full-access');
  });

  test("startGoal: the default permission writes the thread's folder and the chat's extra folders, without network", async () => {
    const { a, server } = setup(
      { 'thread/goal/set': goalAnswer },
      { prefs: { permission: 'plan', planBasePermission: 'default', additionalDirectories: ['/extra'] } },
    );
    await a.startGoal('t1', { kind: 'codex', id: 't1' }, { text: '', attachments: [], opts: { goal: 'ship' } });
    assert.deepEqual(sentOf(server, 'thread/settings/update'), [
      {
        threadId: 't1',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: ['/work', '/extra'],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      },
    ]);
  });

  test("startGoal: a permission that can't be applied starts no goal and says why", async () => {
    const { a, server, events } = setup(
      {
        'thread/goal/set': goalAnswer,
        'thread/settings/update': () => {
          throw new Error('no such method');
        },
      },
      { config: { t1: { permission: 'full-access' } } },
    );
    const res = await a.startGoal('t1', { kind: 'codex', id: 't1' }, { text: '', attachments: [], opts: { goal: 'ship' } }, 7);
    assert.equal(res.started, false);
    assert.match(res.error, /permission/i);
    assert.equal(server.methods().includes('thread/goal/set'), false);
    const toast = events.find((x) => x.e.kind === 'toast');
    assert.match(toast?.e.text, /Couldn't set goal: .*no such method/);
    assert.equal(toast?.target, 7);
    // the optimistic goal row never showed, so nothing is taken back
    assert.equal(
      events.some((x) => x.e.kind === 'goalStarting'),
      false,
    );
  });

  test("leased: a goal change that can carry it on, and a review, apply the chat's permission first; a pause and a compaction don't", async () => {
    const { a, server } = setup(
      { 'thread/goal/set': goalAnswer, 'review/start': () => ({ turn: { id: 'r1' } }) },
      { segments: { chat1: 'seg2' }, config: { chat1: { permission: 'full-access' } } },
    );
    await a.leased('chat1', 'thread/goal/set', { status: 'paused' });
    await a.leased('chat1', 'thread/compact/start', {});
    assert.equal(server.methods().includes('thread/settings/update'), false);
    await a.leased('chat1', 'thread/goal/set', { status: 'active' });
    // a raised budget or a new objective can let Codex carry a stopped goal on
    await a.leased('chat1', 'thread/goal/set', { tokenBudget: 1000 });
    await a.leased('chat1', 'thread/goal/set', { objective: 'ship more' });
    await a.leased('chat1', 'review/start', { target: { type: 'uncommittedChanges' } });
    const order = server.methods().filter((m: string) => m === 'thread/settings/update' || m === 'thread/goal/set' || m === 'review/start');
    assert.deepEqual(order.slice(1), [
      ...['thread/settings/update', 'thread/goal/set'],
      ...['thread/settings/update', 'thread/goal/set'],
      ...['thread/settings/update', 'thread/goal/set'],
      ...['thread/settings/update', 'review/start'],
    ]);
    assert.deepEqual(sentOf(server, 'thread/settings/update'), Array(4).fill({ threadId: 'seg2', ...FULL }));
  });

  test("startGoal: the goal message's own permission and folders win over the chat's, as they do for a turn", async () => {
    const { a, server, state } = setup(
      { 'thread/goal/set': goalAnswer },
      { segments: { chat1: 'seg2' }, config: { chat1: { permission: 'full-access' } } },
    );
    await a.startGoal(
      'chat1',
      { kind: 'codex', id: 'seg2' },
      { text: '', attachments: [], opts: { goal: 'ship', permission: 'auto-review', additionalDirectories: ['/x'] } },
    );
    assert.deepEqual(sentOf(server, 'thread/settings/update'), [
      {
        threadId: 'seg2',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: ['/work', '/x'],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      },
    ]);
    assert.equal(state.get('chat1').permission, 'auto-review');
  });

  test("leased: a goal resume whose permission can't be applied is refused, and the goal stays as it was", async () => {
    const { a, server } = setup({
      'thread/goal/set': goalAnswer,
      'thread/settings/update': () => {
        throw new Error('rejected');
      },
    });
    await assert.rejects(a.leased('t1', 'thread/goal/set', { status: 'active' }), /permission.*rejected/i);
    assert.equal(server.methods().includes('thread/goal/set'), false);
  });

  test('applyPermission: with no prefs read yet and no message picks, the chat runs on the default permission', async () => {
    const { a, server, state } = setup();
    a.prefs = () => null;
    await a.ensureResumed('t1');
    await a.applyPermission('t1', 't1', null);
    assert.deepEqual(sentOf(server, 'thread/settings/update'), [
      {
        threadId: 't1',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: ['/work'],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      },
    ]);
    assert.equal(state.get('t1').permission, 'default');
  });

  test("windowRequest: a window's raw request can't start a run on the thread's own settings; codex:leased applies the permission", () => {
    for (const [method, params] of [
      ['thread/goal/set', { threadId: 't', status: 'active' }],
      ['thread/goal/set', { threadId: 't', objective: 'more' }],
      ['review/start', { threadId: 't' }],
    ] as const)
      assert.throws(() => windowRequest(method, params), new RegExp(`A window sends ${method} through codex:leased`));
    assert.equal(windowRequest('thread/goal/set', { threadId: 't', status: 'paused' }), 'thread/goal/set');
    assert.equal(windowRequest('thread/read', undefined), 'thread/read');
    // the methods only main sends stay refused here too
    assert.throws(() => windowRequest('thread/delete', {}), /A window can't send thread\/delete/);
  });
}
