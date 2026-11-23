// Conversation-view UI unit cases for results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, settle, setStore, impl, callsTo, native, T, text, user, turn, chat, view } from './fixture.ts';

export function registerResults() {
  test('background task notes fold into one card per run, each task at its first place with its latest state', async () => {
    const note = (id: string, taskId: string, status: string) => ({
      id,
      type: 'statusNote',
      kind: 'task',
      text: '',
      task: { taskId, kind: 'shell', title: taskId, status, durationMs: null },
    });
    chat([
      turn('t1', [
        note('n1', 'a', 'running'),
        note('n2', 'b', 'running'),
        user('u', 'go on'),
        { id: 'c1', type: 'commandExecution', command: 'ls', status: 'completed' },
        note('n3', 'a', 'completed'),
        note('n4', 'c', 'completed'),
      ]),
    ]);
    const v = await render(view());
    const cards = v.$$('[data-stub="TaskEventCard"]');
    assert.deepEqual(
      cards.map((c) => JSON.parse(c.getAttribute('data-events')!).map((e: any) => `${e.taskId}:${e.status}`)),
      [['a:completed', 'b:running'], ['c:completed']],
    );
    assert.deepEqual(
      cards.map((c) => c.getAttribute('data-chat')),
      [T, T],
    );
    await v.unmount();
  });

  test('a review result ends the turn as a review card', async () => {
    chat([turn('t1', [user('u', '/review'), { id: 'x', type: 'exitedReviewMode', review: 'Looks good', target: { type: 'baseBranch' } }])]);
    const v = await render(view());
    assert.equal(text(v.$('.review-result .plan-card-head')), 'Review · Against a branch');
    await settle(() => chat([turn('t1', [{ id: 'x', type: 'exitedReviewMode', review: 'Fine' }])]));
    assert.equal(text(v.$('.review-result .plan-card-head')), 'Review');
    await v.unmount();
  });

  test('a failed turn explains the error, its details, and offers sign-in when that would fix it', async () => {
    const actions: string[] = [];
    impl['chat:authRecovery'] = (_id: string, msg: string) =>
      /login/.test(msg) ? { signIn: () => actions.push('signIn'), recheck: () => actions.push('recheck') } : null;
    chat([turn('t1', [user('u', 'go')], { status: 'failed', error: { message: 'please login', additionalDetails: 'token expired' } })]);
    const v = await render(view());
    assert.equal(text(v.$('.turn-error-details')), 'token expired');
    await settle(() => v.$$('.turn-error-actions button')[0].click());
    await settle(() => v.$$('.turn-error-actions button')[1].click());
    assert.deepEqual(actions, ['signIn', 'recheck']);
    await settle(() =>
      chat([turn('t1', [user('u', 'go')], { status: 'failed', error: { message: 'rate_limit', additionalDetails: 'rate_limit.' } })]),
    );
    assert.match(text(v.$('.turn-error')), /Out of usage or rate limited/);
    assert.ok(!v.$('.turn-error-details'));
    assert.ok(!v.$('.turn-error-actions'));
    await v.unmount();
  });

  test('#4278: a recovery with nothing of this Mac to check again (a chat on a machine) shows its one button and no Re-check', async () => {
    const actions: string[] = [];
    impl['chat:authRecovery'] = () => ({ label: 'Sign in on machine', signIn: () => actions.push('machine') });
    chat([turn('t1', [user('u', 'go')], { status: 'failed', error: { message: 'Not signed in: the token was refused' } })]);
    const v = await render(view());
    const buttons = v.$$('.turn-error-actions button');
    assert.deepEqual(buttons.map(text), ['Sign in on machine']);
    await settle(() => buttons[0].click());
    assert.deepEqual(actions, ['machine']);
    await v.unmount();
  });

  test('#4908: a login the provider refuses reads once: its words as the reply are not drawn again beside the error, and only the sign-in is offered', async () => {
    const said =
      'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access';
    impl['chat:authRecovery'] = () => ({ label: 'Sign in on machine', signIn: () => undefined });
    chat([turn('t1', [user('u', 'go'), { id: 'a1', type: 'agentMessage', text: said }], { status: 'failed', error: { message: said } })]);
    const v = await render(view());
    assert.ok(!v.$('.assistant-message'), 'the failure is not also the reply');
    assert.equal(v.$$('.turn-error').length, 1);
    assert.deepEqual(v.$$('.turn-error-actions button').map(text), ['Sign in on machine']);
    assert.ok(!v.$$('.turn-error button').some((b: HTMLElement) => text(b) === 'Retry'), 'Retry cannot succeed until the login changes');
    // another failure with a real reply keeps the reply
    await settle(() =>
      chat([
        turn('t1', [user('u', 'go'), { id: 'a1', type: 'agentMessage', text: 'Here is what I found before it stopped.' }], {
          status: 'failed',
          error: { message: 'boom' },
        }),
      ]),
    );
    assert.ok(v.$('.assistant-message'));
    await v.unmount();
  });

  test("a failed turn's sign-in that waits on a login elsewhere shows as waiting, with Cancel, until it ends", async () => {
    const actions: string[] = [];
    impl['chat:authRecovery'] = () => ({
      signIn: () => actions.push('signIn'),
      recheck: () => actions.push('recheck'),
      waiting: { text: (s: any) => (s.signingIn ? 'Waiting for sign-in in the browser…' : null), cancel: () => actions.push('cancel') },
    });
    chat([turn('t1', [user('u', 'go')], { status: 'failed', error: { message: 'please login' } })]);
    const v = await render(view());
    assert.ok(v.$('.turn-error-actions'));
    assert.ok(!v.$('.signin-waiting'));
    await settle(() => setStore({ signingIn: true }));
    assert.ok(!v.$('.turn-error-actions'), 'the ways to sign in give way to Cancel');
    assert.match(text(v.$('.signin-waiting')), /Waiting for sign-in in the browser…/);
    await settle(() => (v.$('.signin-waiting button') as HTMLElement).click());
    assert.deepEqual(actions, ['cancel']);
    await settle(() => setStore({ signingIn: false }));
    assert.ok(v.$('.turn-error-actions'));
    await v.unmount();
  });

  test('edited files can be undone and restored; the patch comes from the turn diff or its edits', async () => {
    const applied: any[] = [];
    let result: any = { ok: true };
    native.git = { applyPatch: async (...a: any[]) => (applied.push(a), result) };
    const edits = {
      id: 'f',
      type: 'fileChange',
      status: 'completed',
      changes: [
        { path: '/repo/new.ts', kind: { type: 'add' }, diff: 'a\nb\n' },
        { path: '/repo/old.ts', kind: 'delete', diff: 'x\n' },
        { path: '/repo/upd.ts', kind: 'update', diff: '@@ -1 +1 @@\n-a\n+b' },
        {
          path: '/repo/full.ts',
          kind: 'update',
          diff: 'diff --git a/full.ts b/full.ts\n--- a/full.ts\n+++ b/full.ts\n@@ -1 +1 @@\n-p\n+q',
        },
        { path: '/repo/none.ts', kind: 'update' },
        // a change saved without a path is left out instead of crashing the chat
        { kind: { type: 'add' }, diff: 'lost\n' },
      ],
    };
    chat([turn('t1', [user('u', 'edit'), edits, { id: 'f2', type: 'fileChange', status: 'failed', changes: [] }])]);
    const v = await render(view());
    const card = () => v.$('[data-stub="EditedFilesCard"]')!;
    assert.equal(card().dataset.labels, 'new.ts,old.ts,upd.ts,full.ts,none.ts');
    await settle(() => card().querySelector<HTMLElement>('.view')!.click());
    assert.deepEqual(callsTo('store:openChanges'), [[{ scope: 'turn', turnId: 't1', file: '/repo/new.ts' }]]);
    await settle(() => card().querySelector<HTMLElement>('.expand')!.click());
    assert.equal(card().dataset.expanded, 'true');
    await settle(() => card().querySelector<HTMLElement>('.undo')!.click());
    const [cwd, patch, reverse] = applied[0];
    assert.equal(cwd, '/repo');
    assert.equal(reverse, true);
    assert.equal(
      patch,
      [
        'diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n',
        'diff --git a/old.ts b/old.ts\ndeleted file mode 100644\n--- a/old.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-x\n',
        'diff --git a/upd.ts b/upd.ts\n--- a/upd.ts\n+++ b/upd.ts\n@@ -1 +1 @@\n-a\n+b\n',
        'diff --git a/full.ts b/full.ts\n--- a/full.ts\n+++ b/full.ts\n@@ -1 +1 @@\n-p\n+q',
      ].join('\n'),
    );
    assert.equal(card().dataset.undone, 'true');
    assert.deepEqual(callsTo('store:toast'), [['Changes undone']]);
    result = { ok: false, stderr: 'patch does not apply\nmore' };
    await settle(() => card().querySelector<HTMLElement>('.undo')!.click());
    assert.equal(applied[1][2], false);
    assert.deepEqual(callsTo('store:toast')[1], ["Couldn't restore: patch does not apply", 'error']);
    result = { ok: true };
    await settle(() => card().querySelector<HTMLElement>('.undo')!.click());
    assert.deepEqual(callsTo('store:toast')[2], ['Changes restored']);
    result = { ok: false, stderr: 'nope' };
    await settle(() => card().querySelector<HTMLElement>('.undo')!.click());
    assert.deepEqual(callsTo('store:toast')[3], ["Couldn't undo: nope", 'error']);
    // a turn with a recorded diff undoes exactly that diff
    const diff = 'diff --git a/z.ts b/z.ts\n--- a/z.ts\n+++ b/z.ts\n@@ -1 +1 @@\n-1\n+2\n';
    await settle(() => chat([turn('t9', [user('u', 'x'), edits], { diff })], {}, { id: T }));
    result = { ok: true };
    await settle(() => v.$('[data-stub="EditedFilesCard"] .undo')!.click());
    assert.equal(applied.at(-1)[1], diff);
    assert.equal(applied.at(-1)[0], '');
    await v.unmount();
  });
}
