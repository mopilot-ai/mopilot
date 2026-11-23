// Computer-use tool cases registered by the original unit-test entrypoint.
import { test, assert, rig } from './fixture.ts';

export function registerToolCases() {
  test('tools: registered as observe and act, each authorizing itself (the registry hook is not asked)', () => {
    const r = rig();
    assert.deepEqual(
      r.reg.list().map((t: any) => [t.name, t.policy]),
      [
        ['computer_screenshot', 'observe'],
        ['computer_elements', 'observe'],
        ['computer_click', 'act'],
        ['computer_type', 'act'],
        ['computer_key', 'act'],
        ['computer_scroll', 'act'],
      ],
    );
    r.done();
  });

  test('a click asks first; Allow once runs it in that app only, and the next click asks again', async () => {
    const r = rig();
    const res = r.reg.invoke('c1', 'c1', 'computer_click', { x: 20, y: 10 });
    const card = await r.answerNext({ decision: 'allow', scope: 'once', level: 'click' });
    assert.equal(card.params.app.name, 'Notes');
    assert.equal(card.params.level, 'click');
    assert.equal(card.params.harness, 'claude');
    const out = await res;
    assert.equal(out.ok, true, JSON.stringify(out.error));
    const click = r.helper.calls.find((c) => c.method === 'click')!;
    assert.deepEqual(click.args, [20, 10, { button: 'left', count: 1, bundleIds: ['com.apple.Notes'] }]);
    // control is taken once per chat; an image model gets a screenshot back
    assert.equal(r.helper.calls.filter((c) => c.method === 'acquireControl').length, 1);
    assert.deepEqual(
      out.content.map((c: any) => c.type),
      ['text', 'image', 'text'],
    );
    // the screenshot is of that app's windows only
    assert.deepEqual(r.helper.calls.find((c) => c.method === 'screenshot')!.args, [{ pid: 7, bundleIds: ['com.apple.Notes'] }]);
    assert.deepEqual(r.grants.forChat('c1'), []);

    const again = r.reg.invoke('c1', 'c1', 'computer_click', { x: 20, y: 10 });
    await r.answerNext({ decision: 'deny' });
    const denied = await again;
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, 'denied');
    assert.equal(r.helper.calls.filter((c) => c.method === 'click').length, 1);
    r.done();
  });

  test('the window glow runs for the call: started once it is allowed, stopped when it ends, even when it fails', async () => {
    const r = rig();
    const first = r.reg.invoke('c1', 'c1', 'computer_click', { x: 20, y: 10 });
    await r.answerNext({ decision: 'allow', scope: 'chat', level: 'click' });
    assert.equal((await first).ok, true);
    const names = () => r.helper.calls.map((c) => c.method);
    // not before the user said yes; around the click, with the app's pid
    assert.ok(names().indexOf('glowStart') > names().indexOf('targetInfo'));
    assert.deepEqual(r.helper.calls.find((c) => c.method === 'glowStart')!.args, [7]);
    assert.ok(names().indexOf('glowStart') < names().indexOf('click'));
    assert.equal(names().at(-1), 'glowStop');

    // a helper that rejects the glow (an older build) does not fail the call; a failing call still stops it
    (r.helper as any).glowStart = async () => Promise.reject(new Error('method not found'));
    (r.helper as any).click = async () => Promise.reject(Object.assign(new Error('boom'), { reason: 'capture_failed' }));
    const failed = await r.reg.invoke('c1', 'c1', 'computer_click', { x: 20, y: 10 });
    assert.equal(failed.ok, false);
    assert.equal(names().at(-1), 'glowStop');
    assert.equal(names().filter((m) => m === 'glowStop').length, 2);
    r.done();
  });

  test('Allow in this chat keeps the grant; a text model gets the element list instead of a screenshot', async () => {
    const r = rig({ modality: 'text' });
    const first = r.reg.invoke('c1', 'c1', 'computer_type', { text: 'hello' });
    await r.answerNext({ decision: 'allow', scope: 'chat', level: 'full' });
    const out = await first;
    assert.equal(out.ok, true);
    assert.deepEqual(
      out.content.map((c: any) => c.type),
      ['text', 'text'],
    );
    assert.match(out.content[1].text, /\[0\.0\] Button "Delete"/);
    // no card the second time
    const second = await r.reg.invoke('c1', 'c1', 'computer_key', { key: 'cmd+a' });
    assert.equal(second.ok, true);
    assert.equal(r.ctl.approvals.get('c1')!.length, 0);
    r.done();
  });

  test('a cancelled call takes its access and confirmation cards down; a late answer grants and runs nothing (#1865)', async () => {
    const r = rig({ modality: 'text' });
    const card = () => r.ctl.approvals.get('c1')?.[0];
    const until = () =>
      new Promise<void>((resolve) =>
        (function wait() {
          card() ? resolve() : setTimeout(wait, 1);
        })(),
      );
    const cancel = new AbortController();
    const asked = r.reg.invoke('c1', 'c1', 'computer_click', { x: 20, y: 10 }, { signal: cancel.signal });
    await until();
    const access = card();
    assert.equal(access.method, 'sage/computerAccess');
    cancel.abort();
    assert.equal((await asked).error.code, 'aborted');
    assert.equal(r.ctl.approvals.get('c1')!.length, 0);
    assert.equal(r.broker.answer(access.id, { decision: 'allow', scope: 'always', level: 'full' }), false);
    assert.deepEqual(r.grants.forChat('c1'), []);
    // the "can't be undone" card goes the same way
    r.grants.grant('c1', { bundleId: 'com.apple.Notes', name: 'Notes' }, 'full', 'always');
    assert.equal((await r.reg.invoke('c1', 'c1', 'computer_elements', {})).ok, true);
    const stop = new AbortController();
    const confirming = r.reg.invoke('c1', 'c1', 'computer_click', { element: '0.0' }, { signal: stop.signal });
    await until();
    assert.equal(card().method, 'sage/computerConfirm');
    stop.abort();
    assert.equal((await confirming).error.code, 'aborted');
    assert.equal(r.ctl.approvals.get('c1')!.length, 0);
    assert.equal(r.helper.calls.filter((c) => c.method === 'click').length, 0);
    r.done();
  });

  test('an action that cannot be undone is confirmed every time, even with Full control', async () => {
    const r = rig({ modality: 'text' });
    r.grants.grant('c1', { bundleId: 'com.apple.Notes', name: 'Notes' }, 'full', 'always');
    // list the elements, then click the Delete button by id
    assert.equal((await r.reg.invoke('c1', 'c1', 'computer_elements', {})).ok, true);
    for (const decision of ['allow', 'deny']) {
      const res = r.reg.invoke('c1', 'c1', 'computer_click', { element: '0.0' });
      const card = await r.answerNext({ decision, scope: 'once' });
      assert.equal(card.method, 'sage/computerConfirm');
      assert.equal(card.params.verb, 'delete');
      assert.equal((await res).ok, decision === 'allow');
    }
    // the element's center, in screen points
    assert.deepEqual(
      r.helper.calls.filter((c) => c.method === 'click').map((c) => c.args.slice(0, 2)),
      [[110, 55]],
    );
    r.done();
  });

  test('refused before any card: an app the helper never controls, a read-only chat', async () => {
    const r = rig({ permission: 'plan' });
    r.helper.target = { pid: 9, bundleId: 'com.apple.systempreferences', name: 'System Settings', refused: 'System Settings' };
    const out = await r.reg.invoke('c1', 'c1', 'computer_click', { x: 1, y: 1 });
    assert.equal(out.error.code, 'refused');
    r.helper.target = { pid: 7, bundleId: 'com.apple.Notes', name: 'Notes' };
    assert.equal((await r.reg.invoke('c1', 'c1', 'computer_click', { x: 1, y: 1 })).error.code, 'read_only');
    assert.equal(r.ctl.approvals.size, 0);
    r.done();
  });

  test('a scheduled task without computer control gets no tool call through, with or without a grant', async () => {
    const r = rig({ scheduled: { unattended: true, computer: false, onApproval: 'wait' } });
    r.grants.grant('c1', { bundleId: 'com.apple.Notes', name: 'Notes' }, 'full', 'chat');
    for (const tool of ['computer_screenshot', 'computer_click']) {
      const out = await r.reg.invoke('c1', 'c1', tool, { x: 1, y: 1 });
      assert.equal(out.error.code, 'refused');
      assert.match(out.error.message, /off for this scheduled task/);
    }
    assert.equal(r.ctl.approvals.size, 0);
    r.done();
  });

  test('a scheduled task that allows computer control still runs a granted app', async () => {
    const r = rig({ scheduled: { unattended: true, computer: true, onApproval: 'wait' } });
    r.grants.grant('c1', { bundleId: 'com.apple.Notes', name: 'Notes' }, 'click', 'chat');
    assert.equal((await r.reg.invoke('c1', 'c1', 'computer_click', { x: 1, y: 1 })).ok, true);
    r.done();
  });

  test('unattended: no card; a granted app still works, a new one is refused and the chat paused', async () => {
    const r = rig({ unattended: 'a turn MoPilot started' });
    r.grants.grant('c1', { bundleId: 'com.apple.Notes', name: 'Notes' }, 'click', 'chat');
    assert.equal((await r.reg.invoke('c1', 'c1', 'computer_click', { x: 1, y: 1 })).ok, true);
    const typed = await r.reg.invoke('c1', 'c1', 'computer_type', { text: 'x' });
    assert.equal(typed.error.code, 'unattended');
    assert.equal(r.ctl.approvals.size, 0);
    assert.deepEqual(
      r.paused.map((p: any) => [p.chatId, p.app.name, p.code]),
      [['c1', 'Notes', 'unattended']],
    );
    assert.equal(r.helper.calls.filter((c) => c.method === 'type').length, 0);
    r.done();
  });

  test('without pause or stop hooks, an unattended refusal and Esc still refuse and let go', async () => {
    const r = rig({ unattended: 'a turn MoPilot started', bare: true });
    r.grants.grant('c1', { bundleId: 'com.apple.Notes', name: 'Notes' }, 'click', 'chat');
    assert.equal((await r.reg.invoke('c1', 'c1', 'computer_click', { x: 1, y: 1 })).ok, true);
    const typed = await r.reg.invoke('c1', 'c1', 'computer_type', { text: 'x' });
    assert.equal(typed.error.code, 'unattended');
    assert.equal(r.paused.length, 0);
    assert.equal(r.cu.controlling, 'c1');
    await r.cu.stop();
    assert.equal(r.cu.controlling, null);
    assert.ok(r.helper.calls.some((c) => c.method === 'releaseControl'));
    r.done();
  });

  test('activity: controlling, take-over and Resume, Esc stops the turn and lets go', async () => {
    const acts: any[] = [];
    const r = rig({ onActivity: (chatId, a) => acts.push([chatId, a && a.state]) });
    const stops: string[] = [];
    r.cu.onStop = (chatId: string) => stops.push(chatId);
    r.grants.grant('c1', { bundleId: 'com.apple.Notes', name: 'Notes' }, 'full', 'always');
    assert.equal((await r.reg.invoke('c1', 'c1', 'computer_click', { x: 1, y: 1 })).ok, true);
    assert.deepEqual(acts, [['c1', 'active']]);
    r.cu.paused('takeover');
    assert.equal(await r.cu.resume('c1'), true);
    assert.equal(await r.cu.resume('c2'), false);
    r.cu.paused('escape');
    await new Promise((res) => setImmediate(res));
    assert.deepEqual(acts, [
      ['c1', 'active'],
      ['c1', 'takeover'],
      ['c1', 'active'],
      ['c1', null],
    ]);
    assert.deepEqual(stops, ['c1']);
    assert.equal(r.cu.controlling, null);
    assert.deepEqual(
      r.helper.calls.filter((c) => /Control$/.test(c.method)).map((c) => c.method),
      ['acquireControl', 'resumeControl', 'releaseControl'],
    );
    r.done();
  });

  test('one chat at a time: another chat waits for the desktop, then takes it', async () => {
    const acts: any[] = [];
    const r = rig({ onActivity: (chatId, a) => acts.push([chatId, a && a.state, a?.holder ?? null]) });
    r.cu.pollMs = 5;
    r.grants.grant('c1', { bundleId: 'com.apple.Notes', name: 'Notes' }, 'full', 'always');
    assert.equal((await r.reg.invoke('c1', 'c1', 'computer_key', { key: 'a' })).ok, true);
    const second = r.reg.invoke('c2', 'c2', 'computer_key', { key: 'b' });
    await new Promise((res) => setTimeout(res, 20));
    assert.deepEqual(acts.at(-1), ['c2', 'waiting', 'c1']);
    await r.cu.release('c1');
    assert.equal((await second).ok, true);
    assert.equal(r.cu.controlling, 'c2');
    assert.deepEqual(acts.slice(-2), [
      ['c1', null, null],
      ['c2', 'active', null],
    ]);
    // a lock another profile holds: waits, then gives up
    r.cu.waitMs = 20;
    await r.cu.release('c2');
    r.helper.acquireControl = async () => {
      throw Object.assign(new Error('the desktop is in use by MoPilot'), { reason: 'lock_busy' });
    };
    const busy = await r.reg.invoke('c3', 'c3', 'computer_key', { key: 'c' });
    assert.equal(busy.error.code, 'busy');
    assert.deepEqual(acts.slice(-2), [
      ['c3', 'waiting', null],
      ['c3', null, null],
    ]);
    r.done();
  });
}
