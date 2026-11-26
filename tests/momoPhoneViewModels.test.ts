// MoMo's phone view models over the shared view contract: every state the design draws (header pill, banner, turns, Where MoMo runs, the move, approval, tasks, notes, settings) as words and one-tap fixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const vmPath = '../mobile/src/momoPhone/viewModels';
const fxPath = '../mobile/src/momoPhone/fixtures';
const vm = await import(vmPath);
const cm = await import('../mobile/src/momoPhone/common');
const { fixtureView, fixtureShared } = await import(fxPath);

const at = (h: number, m: number, d = 24) => new Date(2026, 10, d, h, m).getTime();
// a view with the shared part edited in place
const make = (f: (v: any) => void = () => undefined, over: object = {}) => {
  const view = fixtureShared();
  f(view);
  return fixtureView({ view, ...over });
};
const homeIs = (state: string, extra: object = {}) => make((v) => Object.assign(v.home, { state, stateSince: at(13, 12), ...extra }));
const labels = (xs: { label: string }[]) => xs.map((x) => x.label);

test('clock, ago and shortDate read like the design', () => {
  assert.equal(cm.clock(at(13, 12)), '1:12 PM');
  assert.equal(cm.clock(at(0, 5)), '12:05 AM');
  assert.equal(cm.clock(at(12, 0)), '12:00 PM');
  assert.equal(cm.ago(at(14, 20), at(14, 14)), '6 min ago');
  assert.equal(cm.ago(at(14, 20), at(14, 20)), 'now');
  assert.equal(cm.ago(at(14, 20), at(12, 0)), '2 h ago');
  assert.equal(cm.ago(at(14, 20), at(15, 0)), 'now');
  assert.equal(cm.shortDate(at(9, 0, 5)), 'Nov 5');
  assert.deepEqual(['08:00', '22:00', '00:00', '12:30', '07:05'].map(cm.time12), [
    '8:00 AM',
    '10:00 PM',
    '12:00 AM',
    '12:30 PM',
    '7:05 AM',
  ]);
});

test('the header pill names the home and shows its state', () => {
  assert.deepEqual(vm.headerPill(fixtureView()), { label: 'MoMo · Studio', dot: 'green', hint: 'Runs on Studio' });
  assert.deepEqual([vm.headerPill(homeIs('asleep')).dot, vm.headerPill(homeIs('asleep')).hint], ['amber', 'Studio is asleep']);
  assert.equal(vm.headerPill(homeIs('moving')).hint, 'Moving');
  assert.deepEqual([vm.headerPill(homeIs('needs-update')).dot, vm.headerPill(homeIs('needs-update')).hint], ['red', 'Out of date']);
  assert.equal(vm.headerPill(homeIs('needs-sign-in')).hint, 'Signed out');
  assert.deepEqual(vm.headerPill(homeIs('dozing')), { label: 'MoMo · Studio', dot: 'amber', hint: 'Studio' });
  assert.equal(vm.headerPill(homeIs('running', { movedAway: { machine: { machineId: 's', name: 'Studio' }, at: 1 } })).dot, 'grey');
  assert.equal(vm.headerPill(make((v) => (v.home.machineName = null))).label, 'MoMo · your machine');
});

test('the home banner says why and offers the one-tap fix for each home state', () => {
  assert.equal(vm.homeBanner(fixtureView()), null);
  assert.equal(vm.homeBanner(homeIs('moving')), null);
  assert.equal(vm.homeBanner(homeIs('dozing')), null);
  const sleep = vm.homeBanner(homeIs('asleep'));
  assert.equal(sleep.title, "MoMo's home went to sleep at 1:12 PM");
  assert.deepEqual(labels(sleep.actions), ['Wake Studio', 'Move MoMo']);
  assert.deepEqual(sleep.actions[1].intent, { kind: 'open-where' });
  const waking = make((v) => Object.assign(v.home, { state: 'asleep', stateSince: null }), { waking: true });
  assert.equal(vm.homeBanner(waking).actions[0].label, 'Waking Studio…');
  assert.match(vm.homeBanner(waking).title, /^MoMo's home went to sleep at \d/);
  const old = vm.homeBanner(homeIs('needs-update'));
  assert.equal(old.title, 'MoPilot on Studio is out of date');
  assert.deepEqual(old.actions[0].intent, { kind: 'update-machine', machineId: 'studio' });
  const problem = (kind: string, agent: string) => ({ kind, agent, fix: { id: 'f1', label: `Fix ${agent}` } });
  const out = vm.homeBanner(homeIs('needs-sign-in'));
  assert.equal(out.title, 'Claude Code is signed out on Studio');
  assert.deepEqual(labels(out.actions), ['Sign in on Studio', 'Use Codex']);
  const own = vm.homeBanner(homeIs('needs-sign-in', { agentProblem: problem('signed-out', 'Claude Code') }));
  assert.equal(own.actions[0].label, 'Fix Claude Code');
  assert.deepEqual(own.actions[0].intent, { kind: 'sign-in-agent', agent: 'claude', machineId: 'studio' });
  const solo = homeIs('needs-sign-in', { agentProblem: problem('signed-out', 'Claude Code') });
  solo.view.home.machines[0].agentsSignedIn = [];
  assert.deepEqual(labels(vm.homeBanner(solo).actions), ['Fix Claude Code']);
  const codex = homeIs('needs-sign-in', { agentProblem: problem('signed-out', 'Codex') });
  assert.deepEqual(labels(vm.homeBanner(codex).actions), ['Fix Codex']);
  assert.equal(vm.homeBanner(codex).actions[0].intent.agent, 'codex');
  const missing = vm.homeBanner(homeIs('needs-sign-in', { agentProblem: { kind: 'not-installed', agent: 'Claude Code', fix: null } }));
  assert.equal(missing.title, "Claude Code isn't installed on Studio");
  assert.deepEqual(missing.actions[0].intent, { kind: 'install-agent', agent: 'claude', machineId: 'studio' });
  assert.equal(missing.actions[0].label, 'Install on Studio');
  const to = { machineId: 'studio', name: 'Studio' };
  const away = vm.homeBanner(homeIs('running', { movedAway: { machine: to, at: at(15, 2) } }));
  assert.deepEqual(
    [away.title, away.actions[0].label, away.actions[0].intent],
    ['MoMo moved to Studio at 3:02 PM.', 'Open Studio', { kind: 'choose-home', machineId: 'studio' }],
  );
  const none = make((v) => (v.home.homeMachineId = null));
  assert.equal(
    vm.homeBanner(Object.assign(none, { view: { ...none.view, home: { ...none.view.home, state: 'needs-update' } } })).actions[0].intent
      .machineId,
    '',
  );
});

test('delivery problems show the exact sentence and their fix', () => {
  assert.deepEqual(vm.deliveryProblems(fixtureView()), []);
  const rows = vm.deliveryProblems(
    make((v) =>
      v.problems.push({
        id: 'push:1',
        code: 'notifications_off',
        cause: 'Notifications are off.',
        fix: { id: 'f9', label: 'Open Settings' },
        since: 1,
      }),
    ),
  );
  assert.deepEqual(rows, [
    { id: 'push:1', cause: 'Notifications are off.', action: { label: 'Open Settings', intent: { kind: 'fix', id: 'f9' } }, also: [] },
  ]);
});

test('the composer says when a message waits', () => {
  assert.equal(vm.composerHint(fixtureView()), 'Message MoMo');
  assert.equal(vm.composerHint(homeIs('asleep')), 'Message MoMo · sends when Studio is back');
});

test('a sent message says waiting, or after a lost connection what the home knows, and never resends by itself', () => {
  const view = fixtureView();
  const row = (delivery: string) => ({ kind: 'user', id: 'u', at: 1, text: 'Yes, attach it.', delivery });
  const waiting = vm.turnRow(view, row('queued'));
  assert.deepEqual([waiting.status, waiting.sub, waiting.actions], ['Waiting for Studio', null, []]);
  const has = vm.turnRow(view, row('accepted'));
  assert.deepEqual([has.status, has.sub], ['Studio has it', 'Working on it now']);
  assert.deepEqual([vm.turnRow(view, row('completed')).status, vm.turnRow(view, row('completed')).sub], ['Studio has it', null]);
  assert.equal(vm.turnRow(view, row('failed')).status, "MoMo couldn't do it");
  assert.equal(vm.turnRow(view, row('cancelled')).status, 'Stopped');
  assert.deepEqual(
    [vm.turnRow(view, row('interrupted')).status, vm.turnRow(view, row('interrupted')).sub],
    ['Interrupted', 'It may have partly finished.'],
  );
  const never = vm.turnRow(view, row('never-got-it'));
  assert.deepEqual([never.status, never.sub], ['Studio never got it', 'Not sent. Send now?']);
  assert.deepEqual(never.actions[0].intent, { kind: 'send', turnId: 'u', text: 'Yes, attach it.' });
  for (const delivery of ['not-sure', 'something-new']) {
    const unsure = vm.turnRow(view, row(delivery));
    assert.deepEqual([unsure.status, unsure.sub], ['Not sure', 'Studio may have started. Check before sending again.']);
    assert.deepEqual(unsure.actions[0].intent, { kind: 'check-turn', turnId: 'u' });
  }
  const chat = fixtureView().view.chat;
  assert.equal(vm.turnStatus(view, chat[1]), null);
  const last = make((v) => v.chat.splice(2));
  assert.equal(vm.turnStatus(last, last.view.chat[1]).status, 'Studio has it');
  assert.equal(vm.turnStatus(view, row('queued')).status, 'Waiting for Studio');
  assert.equal(vm.turnStatus(view, row('completed')), null);
});

test('Where MoMo runs lists the home, then Move, Update and Set up rows', () => {
  const rows = vm.whereRows(fixtureView());
  assert.equal(rows.here.subtitle, 'MoMo is here');
  assert.deepEqual(
    rows.others.map((r: { name: string; action: { label: string } | null }) => [r.name, r.action?.label]),
    [
      ['This Mac', 'Move'],
      ['Mac mini', 'Update'],
      ['Cloud machine', 'Set up'],
    ],
  );
  assert.deepEqual(
    rows.others.map((r: { subtitle: string }) => r.subtitle),
    ['Online · stops when the lid closes', 'MoPilot there is out of date', 'Not set up · wakes when MoMo has work, stops when idle'],
  );
  assert.match(rows.footnote, /^Moving takes about a minute/);
  const odd = make((v) => {
    v.home.machines = [
      {
        machineId: 'a',
        name: 'A',
        isThisDevice: false,
        isHome: false,
        status: 'online',
        note: null,
        recommended: false,
        agentsSignedIn: [],
      },
      {
        machineId: 'b',
        name: 'B',
        isThisDevice: false,
        isHome: false,
        status: 'offline',
        note: null,
        recommended: false,
        agentsSignedIn: [],
      },
      {
        machineId: 'c',
        name: 'C',
        isThisDevice: false,
        isHome: false,
        status: 'not-set-up',
        note: null,
        recommended: false,
        agentsSignedIn: [],
      },
    ];
  });
  const r = vm.whereRows(odd);
  assert.equal(r.here, null);
  assert.deepEqual(
    r.others.map((x: { subtitle: string; action: unknown }) => [x.subtitle, x.action === null]),
    [
      ['Online', false],
      ['Offline', true],
      ['Not set up', false],
    ],
  );
});

test('the home card lists what runs there', () => {
  assert.deepEqual(vm.homeCardLines(fixtureView()), [
    'Online · this phone is connected to it',
    'Keeps running when your Mac sleeps',
    'Claude Code and Codex signed in',
    'Gmail and Calendar connected · read only',
  ]);
  const bare = make((v) => {
    Object.assign(v.home.machines[0], { status: 'offline', note: null, agentsSignedIn: [] });
    v.home.sources = [];
  });
  assert.deepEqual(vm.homeCardLines(bare), ['Offline']);
  const needsYou = make((v) => (v.home.sources[0].status = 'needs-reconnect'));
  assert.equal(vm.homeCardLines(needsYou).length, 3);
  assert.deepEqual(vm.homeCardLines(make((v) => (v.home.machines = []))), []);
});

test('first run recommends the machine that stays on', () => {
  const fr = vm.firstRun(fixtureView());
  assert.deepEqual([fr.chosen, fr.cta], ['studio', 'Continue with Studio']);
  assert.deepEqual(
    fr.rows.map((r: { name: string; recommended: boolean }) => [r.name, r.recommended]),
    [
      ['Studio', true],
      ['This Mac', false],
      ['Mac mini', false],
    ],
  );
  assert.equal(fr.rows[0].action, null);
  const none = vm.firstRun(make((v) => v.home.machines.forEach((m: { recommended: boolean }) => (m.recommended = false))));
  assert.deepEqual([none.chosen, none.cta], [null, null]);
});

test('the move shows its steps with Cancel until the switch, then failure with Retry and Stay, then finished late', () => {
  assert.equal(vm.movePanel(fixtureView()), null);
  const ref = (machineId: string, name: string) => ({ machineId, name });
  const moveOf = (step: string, extra: object = {}) =>
    homeIs('moving', {
      move: {
        moveId: 'm',
        from: ref('studio', 'Studio'),
        to: ref('mini', 'Mac mini'),
        step,
        outcome: 'running',
        finishedAt: null,
        failure: null,
        oldMachineOffline: false,
        ...extra,
      },
    });
  const copied = vm.movePanel(moveOf('copied'));
  assert.deepEqual([copied.title, copied.from], ['Moving MoMo to Mac mini', 'From Studio · about a minute']);
  assert.deepEqual(
    copied.steps.map((s: { label: string; state: string }) => [s.label, s.state]),
    [
      ['Paused', 'done'],
      ['Sealed', 'done'],
      ['Copied', 'current'],
      ['Switching', 'todo'],
      ['Resuming', 'todo'],
      ['Cleaning up', 'todo'],
    ],
  );
  // every move button names the move its card was drawn for, so a card that outlived its move cannot act on the next one
  assert.deepEqual(copied.cancel.intent, { kind: 'move-cancel', moveId: 'm' });
  assert.equal(copied.cancelNote, 'You can cancel until the switch.');
  const switching = vm.movePanel(moveOf('switching'));
  assert.deepEqual([switching.cancel, switching.cancelNote], [null, 'It is switching. It cannot be cancelled now.']);
  assert.equal(vm.movePanel(moveOf('mystery')).cancel, null, 'an unknown step is never cancellable');
  assert.deepEqual(
    vm.movePanel(moveOf('mystery')).steps.map((s: { state: string }) => s.state),
    ['todo', 'todo', 'todo', 'todo', 'todo', 'todo'],
  );
  assert.deepEqual([vm.moveStepLabel('cleaning-up'), vm.moveStepLabel('mystery')], ['Cleaning up', 'mystery']);
  const failed = vm.movePanel(
    moveOf('copied', { outcome: 'failed', failure: { cause: 'Mac mini stopped answering.', failedAt: 'copied' } }),
  );
  assert.deepEqual(
    [failed.title, failed.cause, failed.lastStep],
    ["Move didn't finish", 'Mac mini stopped answering. MoMo is still on Studio. Nothing was lost.', 'Last step reached: Copied'],
  );
  assert.deepEqual(labels(failed.actions), ['Retry', 'Stay on Studio']);
  const bare = vm.movePanel(moveOf('copied', { outcome: 'failed' }));
  assert.deepEqual([bare.cause, bare.lastStep], ['The move stopped. MoMo is still on Studio. Nothing was lost.', '']);
  const late = vm.movePanel(moveOf('cleaning-up', { outcome: 'moved', oldMachineOffline: true }));
  assert.deepEqual(
    [late.title, late.body, late.ack.label],
    ['Moved to Mac mini', 'Studio is offline and still holds a copy. It clears itself when it is back.', 'Got it'],
  );
  assert.equal(vm.movePanel(moveOf('cleaning-up', { outcome: 'moved' })), null);
  assert.equal(vm.movePanel(moveOf('copied', { outcome: 'cancelled' })), null);
});

const approvalOf = (extra: object) => ({ ...fixtureShared().chat[2].approval, ...extra });

test('the approval card in each state', () => {
  const now = at(14, 20);
  const view = (extra: object) => vm.approvalView(approvalOf(extra), now);
  const pending = view({});
  assert.deepEqual(
    [pending.title, pending.status, pending.to, pending.attached, pending.footer],
    ['Send this email?', '1 person outside your company.', 'Dana Lee <dana@acme.com>', 'Acme-quote.xlsx', null],
  );
  assert.deepEqual(labels(pending.actions), ['Send', 'Edit', "Don't send"]);
  assert.deepEqual(pending.actions[0].intent, { kind: 'approval', cardId: 'c1', answer: 'send' });
  const two = view({ recipients: [1, 2].map((n) => ({ name: `P${n}`, address: 'a', outsideCompany: true })), attachments: [] });
  assert.deepEqual([two.status, two.attached], ['2 people outside your company.', null]);
  assert.equal(view({ recipients: [{ name: 'Sam', address: 's', outsideCompany: false }] }).status, null);
  const other = view({ action: 'other', title: 'Delete 3 files?', fields: [{ label: 'Where', value: 'Downloads' }] });
  assert.deepEqual([other.to, other.details], [null, [{ label: 'Where', value: 'Downloads' }]]);
  const expired = view({ expiresAt: now - 1, canAskAgain: true });
  assert.deepEqual(
    [expired.status, expired.statusSub, expired.title],
    ['Expired', 'Nobody answered in 30 minutes. Nothing was sent.', 'Send this email? · Dana Lee · Re: Acme renewal'],
  );
  assert.deepEqual(labels(expired.actions), ['Ask again', 'Dismiss']);
  const expiredNoAgain = view({ status: 'expired', subject: null });
  assert.deepEqual([expiredNoAgain.title, labels(expiredNoAgain.actions)], ['Send this email? · Dana Lee', ['Dismiss']]);
  assert.equal(view({ status: 'approved' }).title, 'Sending…');
  assert.equal(view({ status: 'consumed' }).title, 'Sending…');
  assert.equal(view({ status: 'completed' }).title, 'Sent to Dana Lee.');
  assert.equal(view({ status: 'completed', action: 'other' }).title, 'Done.');
  assert.deepEqual([view({ status: 'denied' }).title, view({ status: 'denied' }).actions], ['Not sent.', []]);
  assert.deepEqual(labels(view({ status: 'denied', canAskAgain: true }).actions), ['Ask again']);
  assert.equal(view({ status: 'answered-elsewhere' }).title, 'Not sent.');
  const failed = view({ status: 'failed', failure: { cause: 'Gmail refused it.', fix: { id: 'fx', label: 'Reconnect Gmail' } } });
  assert.deepEqual(
    [failed.title, failed.statusSub, failed.actions[0].label, failed.actions[0].intent],
    ["Couldn't send", 'Gmail refused it.', 'Reconnect Gmail', { kind: 'fix', id: 'fx' }],
  );
  const failedNoFix = view({ status: 'failed', failure: { cause: 'x', fix: null }, canAskAgain: true });
  assert.deepEqual(labels(failedNoFix.actions), ['Ask again']);
  assert.deepEqual([view({ status: 'failed' }).statusSub, view({ status: 'failed' }).actions], [null, []]);
  const unsure = view({ status: 'uncertain', canAskAgain: true });
  assert.deepEqual(
    [unsure.title, unsure.statusSub, labels(unsure.actions)],
    ['Not sure', 'It may have been sent. Check before sending again.', ['Ask again']],
  );
  assert.deepEqual([view({ status: 'mystery' }).title, view({ status: 'mystery' }).actions], ['Send this email?', []]);
  const els = view({ answeredElsewhere: { device: 'iPhone', at: at(14, 31), outcome: 'approved' } });
  assert.deepEqual(
    [els.title, els.statusSub, els.footer],
    ['Answered on your iPhone at 2:31 PM', 'You sent the email to Dana Lee.', 'The card closes on every device.'],
  );
  assert.equal(view({ answeredElsewhere: { device: 'Mac', at: 1, outcome: 'denied' } }).statusSub, 'You did not send it.');
  assert.equal(view({ action: 'other', answeredElsewhere: { device: 'Mac', at: 1, outcome: 'approved' } }).statusSub, 'You said yes.');
});

test('the rule suggestion and its Undo come from the rule’s own state', () => {
  const s = { ruleId: 'r1', text: 'Second time. I will stay quiet about deliveries.' };
  assert.equal(vm.suggestionView(fixtureView(), null), null);
  const on = vm.suggestionView(fixtureView(), s);
  assert.deepEqual([on.line, on.sub], ['Second time. I will stay quiet about deliveries.', 'On now. Undo any time.']);
  assert.deepEqual(labels(on.actions), ['Undo', 'See rule']);
  assert.deepEqual([on.actions[0].intent, on.actions[1].intent], [{ kind: 'rule-undo', ruleId: 'r1' }, { kind: 'open-rules' }]);
  const undone = make((v) => (v.rules[0].state = 'undone'));
  const off = vm.suggestionView(undone, s);
  assert.deepEqual([off.line, off.sub], ['Undone. I will keep telling you about deliveries.', "I won't suggest this again for 30 days."]);
  assert.deepEqual([off.actions[0].label, off.actions[0].intent], ['See rules', { kind: 'open-rules' }]);
  assert.equal(vm.suggestionView(undone, { ruleId: 'r1', text: 'Quieter now.' }).line, 'Undone.');
});

test('the brief and the catch-up cards', () => {
  const view = fixtureView();
  const brief = {
    day: '2026-11-24',
    greeting: 'Morning. One thing needs you.',
    attention: { text: "Dana's quote is due Friday. I can draft it.", source: 'Gmail' },
    offers: [{ id: 'o1', title: 'Draft the quote reply', why: 'Due Friday' }],
    overnight: { read: 38, notesUpdated: 4, rulesLearned: 1 },
    leftOut: [],
  };
  const c = vm.briefCard(view, brief);
  assert.deepEqual(
    [c.greeting, c.attention, c.overnight],
    [
      'Morning. One thing needs you.',
      "Dana's quote is due Friday. I can draft it.",
      'Overnight on Studio: 38 messages read, 4 notes updated, 1 rule learned.',
    ],
  );
  assert.deepEqual(labels(c.offers[0].actions), ['Hide', 'Start']);
  assert.deepEqual(c.offers[0].actions[1].intent, { kind: 'offer', briefDay: '2026-11-24', offerId: 'o1', action: 'start' });
  const quiet = vm.briefCard(view, { ...brief, attention: null, overnight: { read: 1, notesUpdated: 1, rulesLearned: 2 } });
  assert.deepEqual([quiet.attention, quiet.overnight], [null, 'Overnight on Studio: 1 message read, 1 note updated, 2 rules learned.']);
  const machine = { machineId: 'studio', name: 'Studio' };
  const catchUp = vm.catchUpCard({
    machine,
    from: at(13, 12),
    to: at(15, 40),
    read: 14,
    needsYou: [{ id: 'x', text: "Dana Lee's reply on Acme" }],
  });
  assert.deepEqual(
    [catchUp.title, catchUp.body],
    ['While Studio was asleep, 1:12 PM to 3:40 PM', "Read 14 messages. 1 needs you: Dana Lee's reply on Acme. 13 can wait."],
  );
  assert.equal(vm.catchUpCard({ machine, from: 1, to: 2, read: 3, needsYou: [] }).body, 'Read 3 messages. Nothing needs you.');
});

test('agents have their display names', () => {
  assert.equal(vm.agentName('codex'), 'Codex');
  assert.equal(vm.agentName('claude'), 'Claude Code');
});

test('the pill of a phone with no home yet says where to choose one, not that a machine sleeps', () => {
  const v = make((x: any) => (x.home = { ...x.home, state: 'asleep', homeMachineId: null, machines: [] }));
  const pill = vm.headerPill(v);
  assert.deepEqual([pill.label, pill.dot, pill.hint], ['MoMo', 'grey', 'Where should MoMo live?']);
});

test('a move that was cancelled or reclaimed draws nothing, even with its failure still on record', () => {
  const move = (outcome: string) =>
    make((x: any) => {
      x.home.move = {
        moveId: 'm1',
        from: { machineId: 'a', name: 'Studio' },
        to: { machineId: 'b', name: 'Mac mini' },
        step: 'switching',
        outcome,
        finishedAt: 1,
        failure: { cause: 'MoMo runs on its old machine again.', failedAt: 'switching' },
        oldMachineOffline: false,
        reclaim: null,
      };
    });
  assert.equal(vm.movePanel(move('cancelled')), null);
  assert.equal(vm.movePanel(move('failed'))?.kind, 'failed');
});

test('Edit is offered only on a card the home says it can edit', () => {
  const card = (extra: object) => vm.approvalView(approvalOf(extra), at(14, 20));
  assert.deepEqual(labels(card({ editable: true }).actions), ['Send', 'Edit', "Don't send"]);
  assert.deepEqual(labels(card({ editable: false }).actions), ['Send', "Don't send"]);
  assert.deepEqual(labels(card({ editable: undefined }).actions), ['Send', "Don't send"]);
});
