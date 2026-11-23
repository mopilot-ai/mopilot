// src/lib/machinePicker.ts: a machine's agents as the model picker's rows (#4907): models named by the version in the Host's description, the default shown as the model it is (or saying the Host did not report it), each login's account, billing and usage, and the agent rows' states.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountSigninAction,
  activeLogin,
  agentLine,
  agentRow,
  effortWord,
  loginRows,
  machineChoices,
  reportedCliLoginState,
  resolvedDefault,
} from '../src/lib/machinePicker.ts';

const model = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  default: false,
  efforts: ['low', 'high'],
  defaultEffort: null,
  ...over,
});
const login = (over: Record<string, unknown> = {}) => ({
  id: 'a',
  label: 'me@work.com',
  state: 'ok',
  limited: false,
  billing: 'subscription',
  active: true,
  ...over,
});
const agent = (over: Record<string, unknown> = {}): any => ({ id: 'claude', label: 'Claude Code', state: 'ready', reason: '', ...over });

test('the model a default entry names: "currently X", or a family and version at the head, else none', () => {
  assert.equal(resolvedDefault('Use the default model (currently Opus 5.5) · $5/$25'), 'Opus 5.5');
  assert.equal(resolvedDefault('Sonnet 4.5 · Best for everyday tasks'), 'Sonnet 4.5');
  assert.equal(resolvedDefault('Haiku 4'), 'Haiku 4');
  assert.equal(resolvedDefault('Most capable for complex work'), null);
  // an alias or a raw id is never a name
  assert.equal(resolvedDefault('Use the default model (currently opus)'), null);
  assert.equal(resolvedDefault('Use the default model (currently claude-opus-4-5-20251101)'), null);
  assert.equal(resolvedDefault('Use the default model (currently Opus 5.5 (1M context)) · more'), 'Opus 5.5');
  assert.equal(resolvedDefault(undefined), null);
});

test('models are named by the version in their description and grouped as This Mac groups them', () => {
  const { choices } = machineChoices(
    [
      model('opus', 'Opus', { description: 'Opus 5.5 · Best for complex work' }),
      model('sonnet', 'Sonnet', { description: 'Sonnet 5.5 · Everyday' }),
      model('claude-opus-4-1', 'Opus 4.1', { description: 'Pinned' }),
    ],
    'box',
  );
  assert.deepEqual(
    choices.map((c) => [c.id, c.label, c.more ?? false, c.description]),
    [
      ['opus', 'Opus 5.5', false, 'Best for complex work'],
      ['sonnet', 'Sonnet 5.5', false, 'Everyday'],
      ['claude-opus-4-1', 'Opus 4.1', true, 'Pinned'],
    ],
  );
  assert.equal(choices[0].model.id, 'opus');
});

test('the default entry is the row it resolves to, or a row of its own, or says the Host did not report it', () => {
  const dflt = (description?: string) =>
    model('default', 'Default (recommended)', { default: true, ...(description ? { description } : {}) });
  const opus = model('opus', 'Opus', { description: 'Opus 5.5 · Best' });
  // it resolves to a listed model: that row says Default, and the default entry shows as it
  const same = machineChoices([dflt('Use the default model (currently Opus 5.5)'), opus], 'box');
  assert.deepEqual(
    same.choices.map((c) => [c.id, c.label, c.note]),
    [['opus', 'Opus 5.5', 'Default']],
  );
  assert.equal(same.currentOf('default'), 'opus');
  assert.equal(same.labelOf('default'), 'Opus 5.5');
  assert.equal(same.currentOf('opus'), 'opus');
  assert.equal(same.currentOf(null), null);
  // it resolves to a model with no row of its own: a row named for it
  const alone = machineChoices([dflt('Sonnet 4.5 · Everyday'), opus], 'box');
  assert.deepEqual(
    alone.choices.map((c) => [c.id, c.label, c.note]),
    [
      ['default', 'Sonnet 4.5', 'Default'],
      ['opus', 'Opus 5.5', undefined],
    ],
  );
  assert.equal(alone.currentOf('default'), 'default');
  // the Host does not say: never "Default (recommended)" with nothing behind it
  const unknown = machineChoices([dflt(), opus], 'box');
  assert.deepEqual(unknown.choices[0] && [unknown.choices[0].label, unknown.choices[0].note], ['Default', 'Model not reported by box']);
  assert.equal(unknown.labelOf('default'), 'Default');
  assert.equal(unknown.labelOf('nope'), null);
});

test("another agent's models keep their own names; the default is noted only where there is a choice", () => {
  const many = machineChoices([model('gpt-5.5', 'GPT-5.5', { default: true }), model('gpt-5.4', 'GPT-5.4')], 'box');
  assert.deepEqual(
    many.choices.map((c) => [c.label, c.note]),
    [
      ['GPT-5.5', 'Default'],
      ['GPT-5.4', undefined],
    ],
  );
  const one = machineChoices([model('only', 'Only', { default: true })], 'box');
  assert.equal(one.choices[0].note, undefined);
  assert.deepEqual(machineChoices([], 'box').choices, []);
});

test('the login an agent runs on: the active one, else the only one, else none', () => {
  assert.equal(activeLogin(agent({ logins: [login({ id: 'a', active: false }), login({ id: 'b' })] }))!.id, 'b');
  assert.equal(activeLogin(agent({ logins: [login({ active: false })] }))!.id, 'a');
  assert.equal(activeLogin(agent({ logins: [login({ id: 'a', active: false }), login({ id: 'b', active: false })] })), null);
  assert.equal(activeLogin(agent()), null);
});

test('a ready agent says who it runs as and what is left, else how the machine has it', () => {
  const usage = [
    { label: '5h', usedPercent: 20, resetsAt: null },
    { label: '7d', usedPercent: 84, resetsAt: 5 },
  ];
  assert.equal(agentLine(agent({ logins: [login({ usage })] }), 'box'), 'me@work.com · 16% left');
  assert.equal(
    agentLine(agent({ logins: [login({ usage: [{ label: 'x', usedPercent: 100, resetsAt: null }] })] }), 'box'),
    'me@work.com · 0% left',
  );
  assert.equal(agentLine(agent({ logins: [login({ limited: true })] }), 'box'), 'me@work.com · Limited');
  assert.equal(agentLine(agent({ logins: [login()] }), 'box'), 'me@work.com');
  // what a chat started now would use comes before the machine's own login
  assert.equal(agentLine(agent({ using: 'key', logins: [login()] }), 'box'), 'Using the key this Mac lends');
  assert.equal(agentLine(agent({ using: 'org', logins: [login()] }), 'box'), "Using your organization's access");
  assert.equal(agentLine(agent({ using: 'key' }), 'box'), 'Using the key this Mac lends');
  assert.equal(agentLine(agent({ using: 'org' }), 'box'), "Using your organization's access");
  assert.equal(agentLine(agent({ using: 'own' }), 'box'), 'Signed in on box');
  assert.equal(agentLine(agent(), 'box'), 'Signed in on box');
});

test("#4908: the CLI's own record of the account (name and plan) names the login where it has no email, and never replaces one", () => {
  const loginAccount = { name: 'Meggie', plan: 'Ultra' };
  assert.equal(agentLine(agent({ loginAccount }), 'box'), 'Meggie · Ultra');
  assert.equal(agentLine(agent({ loginAccount: { name: 'Meggie' } }), 'box'), 'Meggie');
  assert.equal(
    agentLine(agent({ loginAccount, logins: [login({ label: 'This machine', state: 'signedOut' })] }), 'box'),
    'Meggie · Ultra · Signed out',
  );
  assert.equal(agentLine(agent({ loginAccount, logins: [login()] }), 'box'), 'me@work.com');
  assert.equal(agentLine(agent({ loginAccount, using: 'key' }), 'box'), 'Using the key this Mac lends');
  assert.equal(agentRow(agent({ loginAccount }), 'box').usage, 'Meggie · Ultra');
});

test("a login with something wrong says so on the agent's row, in the warning tone, and the account list agrees", () => {
  const row = (l: Record<string, unknown>, over: Record<string, unknown> = {}) => agentRow(agent({ logins: [login(l)], ...over }), 'box');
  assert.deepEqual([row({ state: 'expired' }).usage, row({ state: 'expired' }).usageTone], ['me@work.com · Expired', 'warn']);
  assert.equal(row({ state: 'signedOut' }).usage, 'me@work.com · Signed out');
  assert.deepEqual([row({ limited: true }).usage, row({ limited: true }).usageTone], ['me@work.com · Limited', 'warn']);
  assert.equal(row({}).usageTone, '');
  // a lent key or an organization's access is what a chat would use: the machine's login is not named, so not warned about
  assert.deepEqual(
    [row({ state: 'expired' }, { using: 'key' }).usage, row({ state: 'expired' }, { using: 'key' }).usageTone],
    ['Using the key this Mac lends', ''],
  );
  assert.equal(agentRow(agent({ state: 'signin', reason: 'Sign in on box', logins: [login({ state: 'expired' })] }), 'box').usageTone, '');
  assert.equal(loginRows(agent({ logins: [login({ state: 'expired' })] }))[0].desc, 'Subscription · Expired');
});

test("an agent's row: usable with its line, or disabled with its state and why", () => {
  assert.deepEqual(agentRow(agent(), 'box'), { badge: null, usage: 'Signed in on box', usageTone: '', why: null, disabled: false });
  assert.deepEqual(agentRow(agent({ state: 'missing', reason: 'Not installed on box' }), 'box'), {
    badge: { text: 'Not installed', tone: 'err' },
    usage: null,
    usageTone: '',
    why: 'Install Claude Code on box.',
    disabled: true,
  });
  assert.deepEqual(agentRow(agent({ state: 'signin', reason: 'Sign in on box' }), 'box').badge, { text: 'Signed out', tone: 'warn' });
  assert.deepEqual(agentRow(agent({ state: 'signin', reason: 'Checking on box…' }), 'box').badge, { text: 'Checking…', tone: '' });
});

test("an agent's logins as account rows: the account, how it is billed, and its standing", () => {
  const rows = loginRows(
    agent({
      logins: [
        login({ usage: [{ label: '5h', usedPercent: 40, resetsAt: null }] }),
        login({ id: 'b', label: 'key', billing: 'apiKey', active: false }),
        login({ id: 'c', label: 'old@x.com', state: 'signedOut', active: false }),
        login({ id: 'd', label: 'gone@x.com', state: 'expired', active: false }),
        login({ id: 'e', label: 'busy@x.com', limited: true, active: false }),
      ],
    }),
  );
  assert.deepEqual(
    rows.map((r) => [r.rowKey, r.name, r.desc, r.tone, r.checked]),
    [
      ['a', 'me@work.com', 'Subscription · 60% left', 'ok', true],
      ['b', 'key', 'API key · Signed in', 'ok', false],
      ['c', 'old@x.com', 'Subscription · Signed out', 'warn', false],
      ['d', 'gone@x.com', 'Subscription · Expired', 'warn', false],
      ['e', 'busy@x.com', 'Subscription · Limited', 'warn', false],
    ],
  );
  assert.deepEqual(loginRows(agent()), []);
  // the only login counts as the one in use even when the Host marks none active
  assert.equal(loginRows(agent({ logins: [login({ active: false })] }))[0].checked, true);
  assert.equal(
    loginRows(agent({ logins: [login({ id: 'x', active: false }), login({ id: 'y', active: false })] })).some((r) => r.checked),
    false,
  );
});

test('the chip names the level the selection resolves to, or nothing for a model without levels', () => {
  const label = (e: string) => e.toUpperCase();
  assert.equal(effortWord('low', label), 'LOW');
  assert.equal(effortWord(null, label), null);
});

test('the machine can renew the CLI login when it lapses', () => {
  const own = login({ id: 'default' });
  const added = login({ state: 'signedOut' });
  assert.equal(accountSigninAction(agent()), null);
  assert.equal(accountSigninAction(agent({ logins: [] })), null);
  assert.equal(accountSigninAction(agent({ logins: [own, added] })), null, 'the CLI sign-in cannot renew an added profile');
  assert.equal(accountSigninAction(agent({ logins: [login({ limited: true })] })), null);
  assert.equal(accountSigninAction(agent({ logins: [added] })), null, 'even a sole added profile has a separate sign-in');
  assert.deepEqual(accountSigninAction(agent({ logins: [{ ...own, state: 'signedOut' }] })), { id: 'default', label: 'Sign in again' });
  assert.deepEqual(accountSigninAction(agent({ logins: [{ ...own, state: 'expired', active: false }, login({})] })), {
    id: 'default',
    label: 'Sign in again',
  });
  assert.equal(accountSigninAction(agent({ logins: [added, login({ id: 'b' })] })), null, 'the Host did not identify its own profile');
  const unknown = { ...own, state: 'signedOut', label: 'This machine' };
  assert.deepEqual(accountSigninAction(agent({ logins: [unknown] })), { id: 'default', label: 'Sign in' });
  assert.deepEqual(accountSigninAction(agent({ logins: [unknown], loginAccount: { name: 'Alice' } })), {
    id: 'default',
    label: 'Sign in again',
  });
});

test('a fresh report must identify the installed CLI profile and its actual login state', () => {
  const profile = (state: unknown) => ({ id: 'default', state });
  const report = (agent: object) => ({ harnesses: [{ id: 'claude', detected: true, ...agent }] });
  assert.equal(reportedCliLoginState(null, 'claude'), null);
  assert.equal(reportedCliLoginState(report({ id: 'codex' }), 'claude'), null);
  assert.equal(reportedCliLoginState(report({ detected: false, logins: [profile('signedOut')] }), 'claude'), null);
  assert.equal(reportedCliLoginState(report({ checking: true, logins: [profile('signedOut')] }), 'claude'), null);
  assert.equal(reportedCliLoginState(report({}), 'claude'), null);
  assert.equal(reportedCliLoginState(report({ logins: [{ id: 'another', state: 'signedOut' }] }), 'claude'), null);
  assert.equal(reportedCliLoginState(report({ signedIn: false, logins: [profile('unknown')] }), 'claude'), null);
  for (const state of ['signedOut', 'expired', 'ok']) {
    const logins = [null, { id: 'another' }, profile(state)];
    assert.equal(reportedCliLoginState(report({ signedIn: state === 'ok', logins }), 'claude'), state);
    assert.equal(reportedCliLoginState(report({ signedIn: state !== 'ok', logins }), 'claude'), null, 'the CLI probe must agree');
  }
});

test('#4935: the name the Host resolves wins over the description; the default row names its target, and says "not reported" only when no name came', () => {
  const same = machineChoices(
    [
      model('default', 'Default (recommended)', { default: true, resolvedModel: 'Opus 5.5', description: 'Use the default model' }),
      model('opus', 'Opus', { resolvedModel: 'Opus 5.5' }),
      model('sonnet', 'Sonnet', { description: 'Sonnet 4.5 · Everyday', resolvedModel: 'Sonnet 5.5' }),
    ],
    'box',
  );
  assert.deepEqual(
    same.choices.map((c) => [c.id, c.label, c.note]),
    [
      ['opus', 'Opus 5.5', 'Default'],
      ['sonnet', 'Sonnet 5.5', undefined],
    ],
  );
  assert.equal(same.currentOf('default'), 'opus');
  // a default that resolves to a model the list does not hold is its own row, named
  const own = machineChoices(
    [model('default', 'Default', { default: true, resolvedModel: 'Fable 5.2' }), model('opus', 'Opus', { resolvedModel: 'Opus 5.5' })],
    'box',
  );
  assert.deepEqual([own.choices[0].label, own.choices[0].note], ['Fable 5.2', 'Default']);
  // no name anywhere: the honest line
  const none = machineChoices([model('default', 'Default', { default: true }), model('opus', 'Opus')], 'box');
  assert.equal(none.choices[0].note, 'Model not reported by box');
});

test('an agent the Host could not check is selectable, warns once and offers its reason (#5177)', () => {
  const row = agentRow(agent({ unsure: true, reason: 'Couldn’t check Claude Code on box' }), 'box');
  assert.deepEqual(
    [row.badge?.text, row.why, row.usage, row.disabled],
    ['Couldn’t check', 'Couldn’t check Claude Code on box', null, false],
  );
});
