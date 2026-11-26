// A machine's page (X2): what its data layer reads from each package's call, what each section shows and writes, a section with no data absent, and a locked control disabled with "Managed by <organization>".
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h, act } from 'react';
import './support/dom.ts';
import { render, one } from './support/shell-panels-kit.ts';
import { mockSource } from './support/stubs.ts';
import { installNative } from '../src/lib/native.ts';

const toasts: string[] = [];
mockSource('src/store/core.ts', { toast: (m: string) => void toasts.push(m) });
mockSource('src/lib/flags.ts', { useFlag: () => true, isEnabled: () => true, harnessEnabled: () => true, useEnabledHarnesses: () => [] });

const DOC = {
  version: 1,
  permissionMax: 'full-access',
  approvals: { remindMinutes: 10, pauseMinutes: 30 },
  notify: { needsYou: true, done: false, paused: true, detail: 'tool', quiet: null },
  spend: { dayUsd: 20 },
};
// the status section follows the sign-ins main reports, for an account with Host
const setHost = (over: Record<string, unknown>) =>
  installNative({
    host: {
      access: async () => true,
      onAccess: () => () => undefined,
      onSignin: () => () => undefined,
      signinViews: async () => [],
      ...over,
    },
  } as never);
beforeEach(() => setHost({}));

const data = await import('../src/lib/machinePageData.ts');
const { MachinePage } = await import('../src/components/pages/settings/MachinePage.tsx');
const { MachineDevicesSection, deviceLine } = await import('../src/components/pages/settings/MachineDevicesSection.tsx');
const { MachineRulesSection } = await import('../src/components/pages/settings/MachineRulesSection.tsx');
const { MachineSpendingSection, spendShare } = await import('../src/components/pages/settings/MachineSpendingSection.tsx');
const { MachineActivitySection, exportText, activityWords, collapseActivity } = await import(
  '../src/components/pages/settings/MachineActivitySection.tsx'
);
const { MachineManagedSection } = await import('../src/components/pages/settings/MachineManagedSection.tsx');
const { MachineStatusSection, reachLine } = await import('../src/components/pages/settings/MachineStatusSection.tsx');

const tick = () => new Promise((r) => setImmediate(r));
const machine = (o: object = {}) =>
  ({
    id: 'ssh:box',
    name: 'build-box',
    status: 'online',
    note: '',
    signin: null,
    capabilities: { iab: false, cu: false },
    agents: [{ id: 'claude', label: 'Claude Code', state: 'ready', reason: '' }],
    installable: [],
    lastSeen: null,
    localNetwork: 'unknown',
    waitingForLogin: null,
    startsAtBoot: 'unknown',
    fileVault: 'unknown',
    platform: '',
    ...o,
  }) as any;

test('readers keep what they know and drop the rest', () => {
  assert.equal(data.readDevices('x'), undefined);
  assert.equal(data.readDevices({ clients: [{ nope: 1 }] }), undefined);
  assert.deepEqual(
    data.readDevices([
      { id: 'a', name: 'Work MacBook Pro', kind: 'desktop', self: true, addedAt: 5 },
      { id: 'b', name: 'X', kind: 'toaster' },
    ]),
    [
      { id: 'a', name: 'Work MacBook Pro', kind: 'desktop', thisMac: true, addedAt: 5 },
      { id: 'b', name: 'X', kind: 'other', thisMac: false, addedAt: null },
    ],
  );
  assert.equal(data.readRules(null), undefined);
  assert.equal(data.readRules({ approvals: {}, notify: {} })!.pauseMinutes, 30);
  assert.deepEqual(
    data.readRules({
      ...DOC,
      permissionMax: 'nonsense',
      notify: { ...DOC.notify, detail: 'full', quiet: { start: '22:00', end: '07:00' } },
    })!.notify.quiet,
    {
      start: '22:00',
      end: '07:00',
      tz: '',
    },
  );
  assert.equal(data.readSpend({}, DOC), undefined);
  assert.deepEqual(data.readSpend({ spend: { dayUsd: 4.2, unpriced: 2 } }, { spend: { dayUsd: 20, chatUsd: 10 } }), {
    dayUsd: 4.2,
    dayLimitUsd: 20,
    chatLimitUsd: 10,
    unpriced: true,
  });
  assert.equal(data.readSpend({ spend: { dayUsd: 1, dayLimitUsd: 5 } }, null)!.dayLimitUsd, 5);
  assert.equal(data.readManaged({ policy: { managed: false } }), undefined);
  assert.deepEqual(data.readManaged({ policy: { managed: true, org: 'Acme', locked: ['spend', 4] } }), { org: 'Acme', locked: ['spend'] });
  assert.equal(data.readManaged({ policy: { managed: true } })!.org, 'your organization');
  assert.equal(data.readAudit([]), undefined);
  assert.equal(data.readAudit('x'), undefined);
  assert.equal(data.readAudit({ lines: Array.from({ length: 60 }, (_, i) => ({ at: i, kind: 'k' })) })!.length, 50);
  assert.equal(data.isLocked(undefined, 'spend'), false);
  assert.equal(data.isLocked({ org: 'A', locked: ['spend'] }, 'spend'), true);
});

test('a machine with no other package’s calls shows only its status; each call adds its section', async () => {
  let r = await render(h(MachinePage, { machine: machine(), now: 0, onClose: () => undefined }));
  await act(tick);
  assert.deepEqual(
    [...r.host.querySelectorAll('.settings-group-title')].map((e) => e.textContent),
    ['Status'],
  );
  await r.unmount();
  setHost({
    clients: async () => [{ id: 'p1', name: 'Pocket iPhone', kind: 'phone', addedAt: Date.UTC(2026, 10, 3) }],
    ownerPolicy: async () => DOC,
    hostStatus: async () => ({ spend: { dayUsd: 4.2 }, policy: { managed: true, org: 'Acme', locked: ['permissionMax'] } }),
    audit: async () => [{ at: 1, kind: 'chat.permit', who: 'Pocket iPhone' }],
    phoneDirectList: async () => [{ pairId: 'pair1', fingerprint: 'p1', state: 'offered' }],
  });
  r = await render(h(MachinePage, { machine: machine(), now: 0, onClose: () => undefined }));
  await act(tick);
  assert.deepEqual(
    [...r.host.querySelectorAll('.settings-group-title')].map((e) => e.textContent),
    ['Status', 'Devices', 'Rules', 'Spending', 'Activity', 'Managed'],
  );
  assert.ok(r.host.querySelector('[role=switch][aria-label="Use from Pocket iPhone"]'));
  await r.unmount();
});

test('a call that fails leaves its section out', async () => {
  setHost({ ownerPolicy: async () => Promise.reject(new Error('away')), clients: () => 7 });
  const r = await render(h(MachinePage, { machine: machine(), now: 0, onClose: () => undefined }));
  await act(tick);
  assert.deepEqual(
    [...r.host.querySelectorAll('.settings-group-title')].map((e) => e.textContent),
    ['Status'],
  );
  await r.unmount();
});

test('status: the reach line, the path choice, and Update when the Host is out of date', async () => {
  assert.equal(reachLine(undefined), null);
  assert.equal(reachLine({ mode: 'auto', path: null, latencyMs: null }), null);
  assert.equal(reachLine({ mode: 'auto', path: 'ssh', latencyMs: null }), 'SSH');
  assert.equal(reachLine({ mode: 'auto', path: 'relay', latencyMs: 80.4 }), 'Relay · 80 ms');
  assert.equal(reachLine({ mode: 'auto', path: 'relay', latencyMs: null }), 'Relay');
  const set: any[] = [];
  setHost({ setPath: async (...a: any[]) => void set.push(a), update: async () => undefined });
  const r = await render(
    h(MachineStatusSection, { machine: machine({ hostStale: true, path: { mode: 'auto', path: 'relay', latencyMs: 80 } }), now: 0 }),
  );
  assert.match(r.host.textContent!, /Host is out of date/);
  assert.match(r.host.textContent!, /Relay · 80 ms/);
  assert.ok(one(r.host, 'button', 'Update'));
  await act(async () => (one(r.host, 'button', 'Automatic') as HTMLButtonElement).click());
  await act(async () => (one(document.body, '[role^=menuitem]', 'SSH') as HTMLElement).click());
  assert.deepEqual(set, [['ssh:box', 'ssh']]);
  await r.unmount();
  const plain = await render(h(MachineStatusSection, { machine: machine(), now: 0 }));
  assert.equal(plain.host.querySelector('.select-btn'), null, 'no path, no choice');
  await plain.unmount();
});

test('status: one ready and others signed out says so and offers the first Sign in on the page itself (#4931)', async () => {
  const started: any[] = [];
  setHost({
    signin: async (...a: any[]) => (
      started.push(a), { hostId: a[0], harness: a[1], state: 'starting', codes: [], link: false, url: null, error: null }
    ),
  });
  const agents = [
    { id: 'claude', label: 'Claude Code', state: 'ready', reason: '' },
    { id: 'gemini', label: 'Gemini', state: 'signin', reason: 'Sign in on build-box' },
  ];
  const r = await render(h(MachineStatusSection, { machine: machine({ agents }), now: 0 }));
  assert.match(r.host.textContent!, /Online · Claude Code · Gemini needs sign-in/);
  await act(async () => (one(r.host, 'button', 'Sign in') as HTMLButtonElement).click());
  assert.deepEqual(started, [['ssh:box', 'gemini']]);
  await r.unmount();
  const none = await render(h(MachineStatusSection, { machine: machine(), now: 0 }));
  assert.equal(none.host.querySelector('button'), null, 'nothing to do, no button');
  await none.unmount();
});

test('status: a sign-in under way shows its code field, Open page and Cancel in place of the button, so one click starts one attempt (#4949)', async () => {
  const started: any[] = [];
  const cancelled: any[] = [];
  setHost({
    cancelSignin: async (...a: any[]) => void cancelled.push(a),
    signin: async (...a: any[]) => (
      started.push(a),
      { hostId: a[0], harness: a[1], state: 'waiting', codes: [], link: true, url: 'https://example.com/login', error: null }
    ),
  });
  const agents = [
    { id: 'claude', label: 'Claude Code', state: 'ready', reason: '' },
    { id: 'gemini', label: 'Gemini', state: 'signin', reason: 'Sign in on build-box' },
  ];
  const r = await render(h(MachineStatusSection, { machine: machine({ agents }), now: 0 }));
  await act(async () => (one(r.host, 'button', 'Sign in') as HTMLButtonElement).click());
  await tick();
  assert.deepEqual(started, [['ssh:box', 'gemini']]);
  assert.ok(one(r.host, 'input'), 'the code field the page asks for');
  assert.ok(one(r.host, 'button', 'Open page'));
  assert.equal(
    [...r.host.querySelectorAll('button')].some((b) => b.textContent === 'Sign in'),
    false,
    'no second Sign in while one runs',
  );
  await act(async () => (one(r.host, 'button', 'Cancel') as HTMLButtonElement).click());
  assert.deepEqual(cancelled, [['ssh:box', 'gemini']]);
  await r.unmount();
  const off = await render(h(MachineStatusSection, { machine: machine({ agents, status: 'offline' }), now: 0 }));
  assert.equal(off.host.querySelector('input'), null);
  await off.unmount();
});

test('devices: the line, the phone switch in each enrollment state, and Remove asking first and then closing the device at once', async () => {
  const d = (o: object) =>
    ({ id: 'd', name: 'Pocket iPhone', kind: 'phone', thisMac: false, addedAt: Date.UTC(2026, 10, 3, 12), ...o }) as any;
  assert.equal(deviceLine(d({ thisMac: true, addedAt: null, name: 'Work MacBook Pro' })), 'Work MacBook Pro · this Mac');
  assert.match(deviceLine(d({})), /^Pocket iPhone · added /);
  assert.equal(deviceLine(d({ addedAt: null })), 'Pocket iPhone');
  const sets: any[] = [];
  const removed: any[] = [];
  let fail = false;
  setHost({
    phoneDirectSet: async (...a: any[]) => (fail ? Promise.reject(new Error('no relay')) : void sets.push(a)),
    removeClient: async (...a: any[]) => (fail ? Promise.reject(new Error('refused')) : void removed.push(a)),
  });
  const phones = [
    d({ id: 'a', name: 'Off', direct: { pairId: 'pa', state: 'off' } }),
    d({ id: 'b', name: 'Offered', direct: { pairId: 'pb', state: 'offered' } }),
    d({ id: 'c', name: 'On', direct: { pairId: 'pc', state: 'on' } }),
    d({ id: 'm', name: 'Work MacBook Pro', kind: 'desktop', thisMac: true }),
  ];
  const r = await render(h(MachineDevicesSection, { machineId: 'ssh:box', machineName: 'build-box', devices: phones }));
  // Remove asks first: the sheet names the device and the machine, Cancel leaves everything, Remove goes on
  const sheet = () => document.querySelector('.dialog') as HTMLElement | null;
  const press = (label: string) => act(async () => [...sheet()!.querySelectorAll('button')].find((b) => b.textContent === label)!.click());
  const sw = (name: string) => one(r.host, `[role=switch][aria-label="Use from ${name}"]`) as HTMLButtonElement;
  assert.deepEqual(
    ['Off', 'Offered', 'On'].map((n) => sw(n).getAttribute('aria-checked')),
    ['false', 'true', 'true'],
  );
  assert.equal(r.host.querySelector('[aria-label="Remove Work MacBook Pro"]'), null, 'this Mac has no Remove');
  await act(async () => sw('Off').click());
  assert.deepEqual(sets, [['ssh:box', 'pa', true]]);
  fail = true;
  await act(async () => sw('On').click());
  assert.equal(sw('On').getAttribute('aria-checked'), 'true', 'a refused switch goes back');
  const remove = (name: string) => act(async () => (one(r.host, `[aria-label="Remove ${name}"]`) as HTMLButtonElement).click());
  await remove('Offered');
  assert.match(
    sheet()!.textContent!,
    /Remove Offered[\s\S]*Offered loses its access to build-box now[\s\S]*new pairing code[\s\S]*stay where they are/,
  );
  await press('Cancel');
  assert.equal(sheet(), null);
  assert.deepEqual(removed, [], 'Cancel removes nothing');
  // the sheet's own close button leaves everything as it was too
  await remove('Offered');
  await act(async () => (one(sheet()!, '[aria-label="Close"]') as HTMLElement).click());
  assert.equal(sheet(), null);
  assert.deepEqual(removed, []);
  assert.equal(r.host.textContent!.includes('Offered'), true);
  await remove('Offered');
  await press('Remove');
  assert.equal(sheet(), null, 'the sheet closes');
  assert.equal(r.host.textContent!.includes('Offered'), true, 'a refused removal brings the device back');
  assert.match(toasts.at(-1)!, /refused/i);
  fail = false;
  await remove('Offered');
  await press('Remove');
  assert.deepEqual(removed, [['ssh:box', 'b']]);
  assert.equal(r.host.textContent!.includes('Offered'), false);
  await r.unmount();
});

test('rules: each control sends the whole document and shows what main kept; a locked one is disabled with the organization', async () => {
  const sent: any[] = [];
  let refuse = false;
  setHost({
    setOwnerPolicy: async (doc: any) =>
      refuse
        ? Promise.reject(new Error('Pause is 5 to 720 minutes.'))
        : (sent.push(doc), { doc: { ...doc, approvals: { ...doc.approvals, pauseMinutes: 60 } } }),
  });
  const saved: any[] = [];
  const rules = data.readRules(DOC)!;
  let r = await render(h(MachineRulesSection, { doc: DOC, rules, onSaved: (d: any) => saved.push(d) }));
  await act(async () => (one(r.host, '[role=switch][aria-label="Notify when a run is done"]') as HTMLButtonElement).click());
  assert.equal(sent[0].notify.done, true);
  assert.equal(sent[0].spend.dayUsd, 20, 'the rest of the document goes with it');
  assert.equal(DOC.notify.done, false, 'the page never edits what it was given');
  assert.equal(saved[0].approvals.pauseMinutes, 60, 'what main kept is what shows');
  await act(async () => (one(r.host, '[aria-label="Most a chat may do"]') as HTMLButtonElement).click());
  await act(async () => (one(document.body, '[role^=menuitem]', 'Ask first') as HTMLElement).click());
  assert.equal(sent.at(-1).permissionMax, 'default');
  await act(async () => (one(r.host, '[aria-label="Pause a run after"]') as HTMLButtonElement).click());
  await act(async () => (one(document.body, '[role^=menuitem]', '2 h') as HTMLElement).click());
  assert.equal(sent.at(-1).approvals.pauseMinutes, 120);
  await act(async () => (one(r.host, '[aria-label="Show in notifications"]') as HTMLButtonElement).click());
  await act(async () => (one(document.body, '[role^=menuitem]', 'Full') as HTMLElement).click());
  assert.equal(sent.at(-1).notify.detail, 'full');
  await act(async () => (one(r.host, '[role=switch][aria-label="Quiet hours"]') as HTMLButtonElement).click());
  assert.equal(sent.at(-1).notify.quiet.start, '22:00');
  refuse = true;
  await act(async () => (one(r.host, '[role=switch][aria-label="Notify when a run pauses"]') as HTMLButtonElement).click());
  assert.match(toasts.at(-1)!, /Pause is 5 to 720/);
  await r.unmount();

  const before = sent.length;
  r = await render(
    h(MachineRulesSection, { doc: DOC, rules, managed: { org: 'Acme', locked: ['permissionMax', 'notify'] }, onSaved: () => undefined }),
  );
  assert.match(r.host.textContent!, /Managed by Acme/);
  assert.equal((one(r.host, '[role=switch][aria-label="Notify when a run is done"]') as HTMLButtonElement).disabled, true);
  await act(async () => (one(r.host, '[aria-label="Most a chat may do"]') as HTMLButtonElement).click());
  await act(async () => (one(document.body, '[role^=menuitem]', 'Ask first') as HTMLElement).click());
  assert.equal(sent.length, before, 'a locked control writes nothing');
  await r.unmount();
});

test('rules and limits cannot be written by a build without the owner’s policy', async () => {
  await assert.rejects(
    data.saveOwnerDoc(DOC, () => undefined),
    /cannot change the rules/,
  );
  await assert.rejects(data.removeDevice('m', 'd'), /cannot remove/);
  await assert.rejects(data.setPhoneDirect('m', 'p', true), /cannot set up/);
});

test('spending: today’s total, the bar, and the two limits written into the document', async () => {
  const sent: any[] = [];
  setHost({ setOwnerPolicy: async (doc: any) => (sent.push(doc), { doc }) });
  assert.equal(spendShare({ dayUsd: 5, dayLimitUsd: 20, chatLimitUsd: null, unpriced: false }), 0.25);
  assert.equal(spendShare({ dayUsd: 50, dayLimitUsd: 20, chatLimitUsd: null, unpriced: false }), 1);
  assert.equal(spendShare({ dayUsd: 5, dayLimitUsd: null, chatLimitUsd: null, unpriced: false }), null);
  const saved: any[] = [];
  let r = await render(
    h(MachineSpendingSection, {
      doc: DOC,
      spend: { dayUsd: 4.2, dayLimitUsd: 20, chatLimitUsd: null, unpriced: true },
      onSaved: (d: any) => saved.push(d),
    }),
  );
  assert.match(r.host.textContent!, /About \$4\.20 today/);
  assert.match(r.host.textContent!, /no price/);
  assert.equal(one(r.host, '[role=meter]').getAttribute('aria-valuenow'), '21');
  await act(async () => (one(r.host, '[aria-label="Limit per chat"]') as HTMLButtonElement).click());
  await act(async () => (one(document.body, '[role^=menuitem]', '$10') as HTMLElement).click());
  assert.deepEqual(sent.at(-1).spend, { dayUsd: 20, chatUsd: 10 });
  await act(async () => (one(r.host, '[aria-label="Daily limit"]') as HTMLButtonElement).click());
  await act(async () => (one(document.body, '[role^=menuitem]', 'None') as HTMLElement).click());
  assert.equal(sent.at(-1).spend.dayUsd, undefined);
  assert.equal(saved.length, 2);
  await r.unmount();
  r = await render(
    h(MachineSpendingSection, {
      doc: undefined,
      spend: { dayUsd: 1, dayLimitUsd: null, chatLimitUsd: null, unpriced: false },
      onSaved: () => undefined,
    }),
  );
  assert.equal(r.host.querySelector('[role=meter]'), null, 'no limit, no bar');
  await act(async () => (one(r.host, '[aria-label="Daily limit"]') as HTMLButtonElement).click());
  await act(async () => (one(document.body, '[role^=menuitem]', '$5') as HTMLElement).click());
  assert.equal(sent.length, 2, 'no document to write into');
  await r.unmount();
  r = await render(
    h(MachineSpendingSection, {
      doc: DOC,
      spend: { dayUsd: 1, dayLimitUsd: 20, chatLimitUsd: null, unpriced: false },
      managed: { org: 'Acme', locked: ['spend'] },
      onSaved: () => undefined,
    }),
  );
  assert.match(r.host.textContent!, /Managed by Acme/);
  await act(async () => (one(r.host, '[aria-label="Daily limit"]') as HTMLButtonElement).click());
  await act(async () => (one(document.body, '[role^=menuitem]', '$5') as HTMLElement).click());
  assert.equal(sent.length, 2, 'a locked limit writes nothing');
  await r.unmount();
});

test('activity: each kind in words, who did it where the Host says, repeats within a minute as one row, and the raw lines for Export', async () => {
  const at = (min: number, sec = 0) => Date.UTC(2026, 10, 16, 10, 30) - min * 60_000 - sec * 1000;
  const mac = { who: 'Work MacBook Pro', whoKind: 'desktop' };
  const lines = [
    { at: at(0), kind: 'policy.changed', ...mac },
    { at: at(0, 20), kind: 'policy.changed', ...mac },
    { at: at(0, 50), kind: 'policy.changed', ...mac },
    { at: at(1, 30), kind: 'policy.changed', ...mac },
    { at: at(4), kind: 'policy.changed', ...mac },
    { at: at(5), kind: 'policy.changed', who: 'Pocket iPhone', whoKind: 'phone' },
    { at: at(6), kind: 'client.removed', who: 'Pocket iPhone', whoKind: 'phone' },
    { at: at(7), kind: 'client.added', who: 'Studio Mac', whoKind: 'desktop' },
    { at: at(8), kind: 'client.added', who: '' },
    { at: at(9), kind: 'approval.answered', who: 'Pocket iPhone' },
    { at: at(10), kind: 'something.new', who: '' },
  ];
  assert.deepEqual(activityWords({ at: 1, kind: 'client.removed', who: 'Pocket iPhone', whoKind: 'phone' }), {
    title: 'Phone removed: Pocket iPhone',
    who: '',
  });
  assert.deepEqual(activityWords({ at: 1, kind: 'client.added', who: 'Studio Mac', whoKind: 'desktop' }), {
    title: 'Device added: Studio Mac',
    who: '',
  });
  assert.deepEqual(activityWords({ at: 1, kind: 'client.added', who: '' }), { title: 'Device added', who: '' });
  assert.deepEqual(activityWords({ at: 1, kind: 'policy.changed', who: 'x' }), { title: 'Rules changed', who: 'x' });
  assert.deepEqual(activityWords({ at: 1, kind: 'something.new', who: '' }), { title: 'something.new', who: '' });
  // a removed Mac's relay link kept to refuse it, then deleted (#5747)
  assert.equal(activityWords({ at: 1, kind: 'link.retired', who: '', whoKind: 'controller' }).title, 'Removed Mac’s relay link closed');
  assert.equal(activityWords({ at: 1, kind: 'link.forgotten', who: '' }).title, 'Removed Mac’s relay link deleted');
  // a line the Host records with no name says what kind of client did it
  assert.deepEqual(
    ['desktop', 'phone', 'cli', 'other'].map((whoKind) => activityWords({ at: 1, kind: 'policy.changed', who: '', whoKind }).who),
    ['from a computer', 'from a phone', 'from this machine’s command line', ''],
  );
  assert.deepEqual(
    collapseActivity(lines).map((r) => [r.title, r.who, r.count]),
    [
      ['Rules changed', 'Work MacBook Pro', 4],
      ['Rules changed', 'Work MacBook Pro', 1],
      ['Rules changed', 'Pocket iPhone', 1],
      ['Phone removed: Pocket iPhone', '', 1],
      ['Device added: Studio Mac', '', 1],
      ['Device added', '', 1],
      ['Approval answered', 'Pocket iPhone', 1],
      ['something.new', '', 1],
    ],
    'a chain of lines each within a minute of the last is one; a gap of minutes, another author or another kind is not',
  );
  const r = await render(h(MachineActivitySection, { name: 'build-box', lines }));
  const rows = [...r.host.querySelectorAll('.settings-row')].map((x) => x.textContent);
  assert.match(rows[0]!, /^Rules changed · 4 timesNov 16.* · Work MacBook Pro$/);
  assert.match(rows[3]!, /^Phone removed: Pocket iPhone/);
  assert.equal(r.host.textContent!.includes('policy.changed'), false, 'no raw ids on the page');
  assert.match(exportText(lines), /\tpolicy\.changed\tWork MacBook Pro/, 'Export keeps them');
  await r.unmount();
});

test('activity lists the lines and Export saves them; managed names the organization and what it locks', async () => {
  const lines = [
    { at: Date.UTC(2026, 10, 14, 10), kind: 'chat.permit', who: 'Pocket iPhone' },
    { at: Date.UTC(2026, 10, 14, 9), kind: 'chat.start', who: '' },
  ];
  assert.equal(exportText(lines).split('\n').length, 2);
  assert.match(exportText(lines), /2026-11-14T10:00:00\.000Z\tchat\.permit\tPocket iPhone/);
  const made: any[] = [];
  const proto = Object.getPrototypeOf(document.createElement('a'));
  const click = proto.click;
  proto.click = function () {
    made.push(this.download);
  };
  (URL as any).createObjectURL = () => 'blob:x';
  (URL as any).revokeObjectURL = () => undefined;
  try {
    const r = await render(h(MachineActivitySection, { name: 'build-box', lines }));
    assert.equal(r.host.querySelectorAll('.settings-row').length, 2);
    await act(async () => (one(r.host, 'button', 'Export') as HTMLButtonElement).click());
    assert.deepEqual(made, ['build-box-activity.txt']);
    await r.unmount();
  } finally {
    proto.click = click;
  }
  const m = await render(h(MachineManagedSection, { managed: { org: 'Acme', locked: ['spend', 'weird'] } }));
  assert.match(m.host.textContent!, /Managed by Acme/);
  assert.match(m.host.textContent!, /Spending limits/);
  assert.match(m.host.textContent!, /weird/);
  await m.unmount();
});
