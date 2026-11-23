// Computer-use policy cases registered by the original unit-test entrypoint.
import { test, assert, policy, NOTES, MAIL, rig } from './fixture.ts';

export function registerPolicyCases() {
  test('levels: looking needs View only, plain clicks Click, typing and keys Full control', () => {
    assert.equal(policy.requiredLevel('computer_screenshot'), 'view');
    assert.equal(policy.requiredLevel('computer_elements'), 'view');
    assert.equal(policy.requiredLevel('computer_click', {}), 'click');
    assert.equal(policy.requiredLevel('computer_scroll', {}), 'click');
    assert.equal(policy.requiredLevel('computer_click', { button: 'right' }), 'full');
    assert.equal(policy.requiredLevel('computer_type', { text: 'x' }), 'full');
    assert.equal(policy.requiredLevel('computer_key', { key: 'Return' }), 'full');
  });

  test('a chat grant and a global grant combine; the stronger wins, case-insensitively', () => {
    const grants = [
      { bundleId: 'com.apple.notes', level: 'view' },
      { bundleId: 'com.apple.Notes', level: 'click' },
      { bundleId: 'com.apple.mail', level: 'full' },
    ];
    assert.equal(policy.grantedLevel(grants, 'com.apple.Notes'), 'click');
    assert.equal(policy.grantedLevel(grants, 'com.apple.Safari'), null);
  });

  test('irreversible: what a clicked control says, delete keys, Return in a messaging app', () => {
    const click = (title: string) => policy.irreversible('computer_click', {}, { app: NOTES, element: { title } });
    assert.deepEqual(click('Send'), { verb: 'send', summary: 'Send' });
    assert.equal(click('Delete Note')?.verb, 'delete');
    assert.equal(click('Place order')?.verb, 'pay');
    assert.equal(click('Send payment')?.verb, 'pay');
    assert.equal(click('发送')?.verb, 'send');
    assert.equal(click('Bold'), null);
    assert.equal(policy.irreversible('computer_click', {}, { app: NOTES, element: null }), null);
    assert.equal(policy.irreversible('computer_key', { key: 'cmd+Delete' }, { app: NOTES })?.verb, 'delete');
    assert.equal(policy.irreversible('computer_key', { key: 'Delete' }, { app: NOTES }), null);
    assert.equal(policy.irreversible('computer_key', { key: 'Return' }, { app: MAIL })?.verb, 'send');
    assert.equal(policy.irreversible('computer_key', { key: 'Return' }, { app: NOTES }), null);
    assert.equal(policy.irreversible('computer_type', { text: 'hi\n' }, { app: { bundleId: 'com.apple.MobileSMS' } })?.verb, 'send');
    assert.equal(policy.irreversible('computer_type', { text: 'hi\n' }, { app: NOTES }), null);
    // the model may add a confirmation, never remove one
    assert.equal(policy.irreversible('computer_click', { irreversible: true }, { app: NOTES })?.verb, 'do this');
    assert.equal(policy.irreversible('computer_screenshot', { irreversible: true }, { app: NOTES }), null);
  });

  test('decide: run with a grant, ask without one, confirm what cannot be undone, refuse the deny list and read-only', () => {
    const base = { app: NOTES, grants: [], deny: [], permission: 'default', irreversible: null };
    assert.deepEqual(policy.decide({ ...base, tool: 'computer_click', args: {} }), { action: 'ask', level: 'click' });
    assert.deepEqual(
      policy.decide({ ...base, tool: 'computer_click', args: {}, grants: [{ bundleId: 'com.apple.Notes', level: 'click' }] }),
      { action: 'run' },
    );
    // a View only grant doesn't cover a click
    assert.deepEqual(
      policy.decide({ ...base, tool: 'computer_click', args: {}, grants: [{ bundleId: 'com.apple.Notes', level: 'view' }] }),
      {
        action: 'ask',
        level: 'click',
      },
    );
    // Full control still confirms an action that can't be undone, every time
    const full = [{ bundleId: 'com.apple.Notes', level: 'full' }];
    assert.deepEqual(
      policy.decide({ ...base, tool: 'computer_click', args: {}, grants: full, irreversible: { verb: 'delete', summary: 'Delete' } }),
      { action: 'confirm' },
    );
    assert.equal(policy.decide({ ...base, tool: 'computer_click', args: {}, grants: full, deny: ['com.apple.*'] }).code, 'blocked');
    assert.equal(policy.decide({ ...base, tool: 'computer_click', args: {}, grants: full, permission: 'plan' }).code, 'read_only');
    assert.deepEqual(policy.decide({ ...base, tool: 'computer_screenshot', args: {}, grants: full, permission: 'plan' }), {
      action: 'run',
    });
    assert.equal(policy.decide({ ...base, tool: 'computer_click', args: {}, app: null }).code, 'unknown_app');
  });

  test('anchorOf: Codex from its sandbox, Claude from its mode, a basic harness from the mode id through the quirks anchors', () => {
    const a = policy.anchorOf;
    assert.equal(a({ harness: 'codex', permission: 'read-only' }), 'readOnly');
    assert.equal(a({ harness: 'codex', permission: 'default' }), 'ask');
    assert.equal(a({ harness: 'codex', permission: 'auto-review' }), 'auto');
    assert.equal(a({ harness: 'codex', permission: 'full-access' }), 'full');
    assert.equal(a({ harness: 'claude', permission: 'plan' }), 'readOnly');
    assert.equal(a({ harness: 'claude', permission: 'dontAsk' }), 'readOnly');
    assert.equal(a({ harness: 'claude', permission: 'bypassPermissions' }), 'full');
    assert.equal(a({ harness: 'claude', permission: 'default' }), 'ask');
    const acp = { modes: { currentModeId: 'plan' }, anchors: { plan: 'readOnly', yolo: 'full' } };
    assert.equal(a({ harness: 'acp:qwen', acp }), 'readOnly');
    assert.equal(a({ harness: 'acp:qwen', acp: { ...acp, modes: { currentModeId: 'yolo' } } }), 'full');
    assert.equal(a({ harness: 'acp:qwen', acp: { ...acp, modes: { currentModeId: 'other' } } }), 'ask');
    assert.equal(a({ harness: 'acp:qwen', acp: null }), 'ask');
    // a basic harness's mode names never read as a Claude or Codex permission
    assert.equal(a({ harness: 'acp:qwen', permission: 'plan', acp: null }), 'ask');
  });

  test('decide: the read-only anchor refuses everything but looking; the switch off refuses unattended calls even with a grant', () => {
    const base = { app: NOTES, deny: [], irreversible: null, grants: [{ bundleId: 'com.apple.Notes', level: 'full' }] };
    assert.equal(policy.decide({ ...base, tool: 'computer_click', args: {}, anchor: 'readOnly' }).code, 'read_only');
    assert.deepEqual(policy.decide({ ...base, tool: 'computer_elements', args: {}, anchor: 'readOnly' }), { action: 'run' });
    assert.deepEqual(policy.decide({ ...base, tool: 'computer_click', args: {}, anchor: 'auto' }), { action: 'run' });
    const off = policy.decide({ ...base, tool: 'computer_click', args: {}, unattended: 'a sub-agent', unattendedAllowed: false });
    assert.equal(off.code, 'unattended');
    assert.equal(off.pause, true);
    assert.equal(
      policy.decide({ ...base, tool: 'computer_click', args: {}, unattended: 'a sub-agent', unattendedAllowed: true }).action,
      'run',
    );
    // someone is there: the switch changes nothing
    assert.equal(policy.decide({ ...base, tool: 'computer_click', args: {}, unattended: null, unattendedAllowed: false }).action, 'run');
  });

  test('a click is refused in the read-only tier on Codex and on a basic harness in a read-only mode, with no card', async () => {
    const c = rig({ harness: 'codex', permission: 'read-only' });
    c.grants.grant('c1', { bundleId: 'com.apple.Notes', name: 'Notes' }, 'full', 'chat');
    assert.equal((await c.reg.invoke('c1', 'c1', 'computer_click', { x: 1, y: 1 })).error.code, 'read_only');
    assert.equal((await c.reg.invoke('c1', 'c1', 'computer_elements', {})).ok, true);
    assert.equal(c.ctl.approvals.size, 0);
    c.done();
    const acp = { modes: { currentModeId: 'plan' }, anchors: { plan: 'readOnly' } };
    const b = rig({ harness: 'acp:qwen', acp });
    b.grants.grant('c1', { bundleId: 'com.apple.Notes', name: 'Notes' }, 'full', 'chat');
    assert.equal((await b.reg.invoke('c1', 'c1', 'computer_type', { text: 'x' })).error.code, 'read_only');
    b.done();
    const d = rig({ harness: 'acp:qwen', acp: { ...acp, modes: { currentModeId: 'default' } } });
    d.grants.grant('c1', { bundleId: 'com.apple.Notes', name: 'Notes' }, 'full', 'chat');
    assert.equal((await d.reg.invoke('c1', 'c1', 'computer_type', { text: 'x' })).ok, true);
    d.done();
  });

  test('the unattended switch off refuses a granted app and pauses the chat', async () => {
    const r = rig({ unattended: 'a sub-agent', unattendedAllowed: false });
    r.grants.grant('c1', { bundleId: 'com.apple.Notes', name: 'Notes' }, 'click', 'chat');
    assert.equal((await r.reg.invoke('c1', 'c1', 'computer_click', { x: 1, y: 1 })).error.code, 'unattended');
    assert.equal(r.paused.length, 1);
    assert.equal(r.helper.calls.filter((c) => c.method === 'click').length, 0);
    r.done();
  });

  test('an unattended refusal for a missing grant names the level and tool; an "Allow once" given later covers the chat\'s next call only', async () => {
    const r = rig({ unattended: 'a turn MoPilot started' });
    assert.equal((await r.reg.invoke('c1', 'c1', 'computer_click', { x: 1, y: 1 })).error.code, 'unattended');
    assert.equal(r.paused[0].need, 'click');
    assert.equal(r.paused[0].tool, 'computer_click');
    assert.equal(r.ctl.approvals.size, 0);
    // the card answered with Allow once, while nothing was waiting
    r.cu.allowOnce('c1', NOTES, 'click');
    assert.equal((await r.reg.invoke('c1', 'c1', 'computer_click', { x: 1, y: 1 })).ok, true);
    assert.equal((await r.reg.invoke('c1', 'c1', 'computer_click', { x: 1, y: 1 })).error.code, 'unattended');
    // the switch off is not a missing grant: nothing to ask for
    const off = rig({ unattended: 'a sub-agent', unattendedAllowed: false });
    await off.reg.invoke('c1', 'c1', 'computer_click', { x: 1, y: 1 });
    assert.equal(off.paused[0].need, null);
    r.done();
    off.done();
  });

  test('the unattended callback gets the call id, so a sub-agent call can be told apart', async () => {
    const seen: any[] = [];
    const r = rig();
    r.cu.unattended = async (_chatId: string, ctx: any) => (seen.push(ctx.callId), ctx.callId === 'sub' ? 'a sub-agent' : null);
    r.grants.grant('c1', { bundleId: 'com.apple.Notes', name: 'Notes' }, 'click', 'chat');
    assert.equal((await r.reg.invoke('c1', 'c1', 'computer_click', { x: 1, y: 1 }, { callId: 'main' })).ok, true);
    // a granted app still works for a sub-agent; a new level is refused and the chat paused
    assert.equal((await r.reg.invoke('c1', 'c1', 'computer_type', { text: 'x' }, { callId: 'sub' })).error.code, 'unattended');
    assert.deepEqual(seen, ['main', 'sub']);
    r.done();
  });

  test('unattended: a turn Sage started, scheduled tasks, sub-agents, ten idle minutes, basic tier outside a prompt', () => {
    const human = { human: true };
    assert.equal(policy.unattendedReason({ turn: human, idleMs: 1000 }), null);
    assert.equal(policy.unattendedReason({ turn: { human: false } }), 'a turn MoPilot started');
    assert.equal(policy.unattendedReason({ turn: null }), 'no turn you started');
    assert.equal(policy.unattendedReason({ turn: human, idleMs: policy.IDLE_MS - 1 }), null);
    assert.equal(policy.unattendedReason({ turn: human, idleMs: policy.IDLE_MS }), 'no input for 10 minutes');
    assert.equal(policy.unattendedReason({ turn: human, scheduled: true }), 'a scheduled task');
    assert.equal(policy.unattendedReason({ turn: human, subagent: true }), 'a sub-agent');
    assert.equal(policy.unattendedReason({ turn: human, basic: true, promptActive: false }), 'a tool call outside a prompt');
    assert.equal(policy.unattendedReason({ turn: human, basic: true, promptActive: true }), null);
  });

  test('joining an automatic turn permits attended approval without overriding other computer restrictions', () => {
    const turn = { human: false, userEngaged: true };
    const base = { app: NOTES, tool: 'computer_click', grants: [], unattendedAllowed: false };
    const attended = policy.unattendedReason({ turn, idleMs: 0 });
    assert.equal(attended, null);
    assert.equal(policy.decide({ ...base, unattended: attended }).action, 'ask');
    assert.equal(policy.decide({ ...base, unattended: attended, grants: [{ bundleId: NOTES.bundleId, level: 'click' }] }).action, 'run');
    assert.equal(policy.decide({ ...base, unattended: attended, anchor: 'readOnly' }).code, 'read_only');
    for (const context of [{ scheduled: true }, { subagent: true }, { idleMs: policy.IDLE_MS }, { basic: true, promptActive: false }]) {
      const unattended = policy.unattendedReason({ turn, ...context });
      assert.equal(policy.decide({ ...base, unattended }).code, 'unattended');
    }
  });

  test('unattended: only apps already granted; a new grant or an irreversible action refuses and pauses', () => {
    const base = { app: NOTES, deny: [], permission: 'default', irreversible: null, unattended: 'a turn MoPilot started' };
    const click = [{ bundleId: 'com.apple.Notes', level: 'click' }];
    assert.deepEqual(policy.decide({ ...base, tool: 'computer_click', args: {}, grants: click }), { action: 'run' });
    const ask = policy.decide({ ...base, tool: 'computer_type', args: { text: 'x' }, grants: click });
    assert.equal(ask.action, 'refuse');
    assert.equal(ask.code, 'unattended');
    assert.equal(ask.pause, true);
    assert.match(ask.message, /Controlling Notes needs the user's OK.*\(a turn MoPilot started\)/);
    const irr = policy.decide({
      ...base,
      tool: 'computer_click',
      args: {},
      grants: click,
      irreversible: { verb: 'send', summary: 'Send' },
    });
    assert.equal(irr.code, 'unattended');
    assert.equal(irr.pause, true);
    // the deny list and read-only modes refuse without pausing anything
    assert.equal(policy.decide({ ...base, tool: 'computer_click', args: {}, grants: click, deny: ['com.apple.Notes'] }).pause, undefined);
  });

  test('an answer becomes a grant only when it allows at least the level the call needs', () => {
    assert.deepEqual(policy.grantFromAnswer({ decision: 'allow', scope: 'chat', level: 'full' }, 'click'), {
      scope: 'chat',
      level: 'full',
    });
    assert.deepEqual(policy.grantFromAnswer({ decision: 'allow' }, 'click'), { scope: 'once', level: 'click' });
    assert.equal(policy.grantFromAnswer({ decision: 'allow', scope: 'always', level: 'view' }, 'click'), null);
    assert.equal(policy.grantFromAnswer({ decision: 'deny' }, 'view'), null);
    assert.equal(policy.grantFromAnswer(null, 'view'), null);
  });

  test('observation: a screenshot for image models, the element list for text models, both when unknown', () => {
    assert.deepEqual(policy.observationKinds('image'), ['screenshot']);
    assert.deepEqual(policy.observationKinds('text'), ['elements']);
    assert.deepEqual(policy.observationKinds(null), ['screenshot', 'elements']);
  });
}
