// Settings › My machines › How machines sign in (HostSigninMethod.tsx, HostApiKeys.tsx, HostOrgAccess.tsx): the row names the choice in force; the sheet's three choices show fields only for the chosen one; My API keys saves typed keys (shown by their last four only) and Remove forgets one; My organization saves the admin's settings and signs in, with the client ID, OpenAI gateway and session length under More; Each machine removes both; choosing one ends the other; every refusal is a toast.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  resetCtl,
  responses,
  calls,
  useStore,
  defaultState,
  render,
  click,
  button,
  text,
  setValue,
  flush,
  act,
} from './support/settings-harness.ts';

await setup();
await import('../src/lib/native/host.ts');
const { createElement: h } = await import('react');
const { HostSigninMethod, methodOf } = await import('../src/components/pages/settings/HostSigninMethod.tsx');
const { orgDraft, orgChanged, orgState, saveOrg, saveKeys } = await import('../src/components/pages/settings/HostOrgAccess.tsx').then(
  async (o) => ({
    ...o,
    ...(await import('../src/components/pages/settings/HostApiKeys.tsx')),
  }),
);

const KEY = 'sk-ant-dummy-0000-test-key-abcd';
const CONFIG = {
  issuer: 'https://login.example.com/realms/acme',
  clientId: 'mopilot',
  leaseHours: 6,
  access: { kind: 'gateway', gateways: { anthropic: 'https://llm.example.com/anthropic' } },
};
const org = (state: string, who: string | null = 'ada@example.com') => ({ configured: true, config: CONFIG, state, who, managed: null });
const OFF = { configured: false, config: null, state: 'off', who: null, managed: null };
const toasts = () => calls.filter((c) => c[0] === 'toast').map((c) => c.slice(1));
const named = (n: string) => calls.filter((c) => c[0] === n);
const input = (root: Element, label: string) => root.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null;
const value = (root: Element) => text(root.querySelector('.machine-value'));
let pushOrg: (v: unknown) => void = () => undefined;

beforeEach(() => {
  resetCtl();
  useStore.setState({ ...defaultState(), route: { name: 'settings', section: 'connections' } }, true);
  calls.length = 0;
  Object.assign(responses, {
    'host.apiKeys': () => Promise.resolve({}),
    'host.setApiKey': (_p: string, k: string) => Promise.resolve(`…${k.slice(-4)}`),
    'host.removeApiKey': () => Promise.resolve(true),
    'host.orgAccess': () => Promise.resolve(OFF),
    'host.onOrgAccess': (cb: (v: unknown) => void) => ((pushOrg = cb), () => undefined),
    'host.setOrgAccess': () => Promise.resolve(org('signedOut', null)),
    'host.orgSignIn': () => Promise.resolve(org('signedIn')),
    'host.orgSignOut': () => Promise.resolve(org('signedOut', null)),
    'host.removeOrgAccess': () => Promise.resolve(OFF),
    'host.signOutEverywhere': () => Promise.resolve([]),
  });
});

async function opened(label = 'How machines sign inEach machine') {
  const root = await render(h(HostSigninMethod));
  await flush();
  await click(button(root.host, label));
  return root;
}
const choose = (root: Element, label: string) =>
  click([...root.querySelectorAll('[role=radio]')].find((r) => text(r).startsWith(label)) as HTMLElement);
const checked = (root: Element) => text(root.querySelector('[role=radio][aria-checked=true] .signin-choice-title'));

test('the choice in force: the organization when it is set up, else saved keys, else each machine', () => {
  assert.equal(methodOf({}, null), 'each');
  assert.equal(methodOf({}, OFF as any), 'each');
  assert.equal(methodOf({ anthropic: '…abcd' }, OFF as any), 'keys');
  assert.equal(methodOf({ anthropic: '…abcd' }, org('signedOut') as any), 'org');
});

test('the row says nothing until both answered, then the choice; the sheet names Claude Code and Codex and shows no fields for Each machine', async (t) => {
  let keys: (v: unknown) => void = () => undefined;
  responses['host.apiKeys'] = () => new Promise((r) => (keys = r));
  const root = await render(h(HostSigninMethod));
  t.after(() => root.unmount());
  await flush();
  assert.equal(value(root.host), '');
  await act(async () => keys({ openai: '…wxyz' }));
  assert.equal(value(root.host), 'My API keys');
  await act(() => pushOrg(org('signedIn')));
  assert.equal(value(root.host), 'My organization', 'a change main pushes is followed');
  await act(() => pushOrg(OFF));
  await click(button(root.host, 'How machines sign inMy API keys'));
  assert.match(text(root.host.querySelector('.dialog')), /Applies to every machine\./);
  assert.equal(checked(root.host), 'My API keys');
  assert.match(text(root.host), /My organizationAdmin/);
  await choose(root.host, 'Each machine');
  assert.equal(root.host.querySelectorAll('.dialog input').length, 0);
  await click(button(root.host, 'Cancel'));
  assert.equal(root.host.querySelector('.dialog'), null);
  assert.equal(named('host.removeApiKey').length, 0, 'Cancel changes nothing');
});

test('My API keys: Done waits for a key, saves only typed ones, trimmed; a saved key shows its last four and Remove forgets it', async (t) => {
  const root = await opened();
  t.after(() => root.unmount());
  await choose(root.host, 'My API keys');
  assert.match(text(root.host), /Kept on this Mac, lent to a machine only while a chat runs\./);
  const field = input(root.host, 'Anthropic key')!;
  assert.deepEqual([field.type, field.autocomplete, field.placeholder], ['password', 'off', 'Anthropic key  sk-ant-…']);
  assert.equal(button(root.host, 'Done').disabled, true, 'nothing typed, nothing saved');
  await setValue(field, `  ${KEY} `);
  await click(button(root.host, 'Done'));
  await flush();
  assert.deepEqual(named('host.setApiKey'), [['host.setApiKey', 'anthropic', KEY]]);
  assert.equal(named('host.removeOrgAccess').length, 0, 'no organization to end');
  assert.equal(root.host.querySelector('.dialog'), null);
  assert.equal(value(root.host), 'My API keys');
  await click(button(root.host, 'How machines sign inMy API keys'));
  assert.match(text(root.host), /Anthropic key · saved \(…abcd\)/);
  assert.doesNotMatch(text(root.host), /sk-ant-dummy/);
  assert.equal(button(root.host, 'Done').disabled, false, 'a saved key is enough');
  await click(button(root.host, 'Remove the Anthropic key'));
  await flush();
  assert.deepEqual(named('host.removeApiKey'), [['host.removeApiKey', 'anthropic']]);
  assert.ok(input(root.host, 'Anthropic key'));
  // a refusal is a toast, and the sheet stays
  responses['host.setApiKey'] = () => Promise.reject(new Error('That is not an Anthropic key.'));
  await setValue(input(root.host, 'Anthropic key')!, 'nope');
  await click(button(root.host, 'Done'));
  await flush();
  assert.deepEqual(toasts().at(-1), ['That is not an Anthropic key.', 'error']);
  assert.ok(root.host.querySelector('.dialog'));
});

test('choosing keys ends the organization; choosing each machine removes the keys and the organization', async (t) => {
  responses['host.apiKeys'] = () => Promise.resolve({ anthropic: '…abcd', openai: '…wxyz' });
  responses['host.orgAccess'] = () => Promise.resolve(org('signedIn'));
  const root = await render(h(HostSigninMethod));
  t.after(() => root.unmount());
  await flush();
  await click(button(root.host, 'How machines sign inMy organization'));
  assert.equal(checked(root.host), 'My organizationAdmin');
  await choose(root.host, 'My API keys');
  await click(button(root.host, 'Done'));
  await flush();
  assert.equal(named('host.removeOrgAccess').length, 1);
  assert.equal(named('host.setApiKey').length, 0, 'nothing typed');
  assert.equal(value(root.host), 'My API keys');
  await click(button(root.host, 'How machines sign inMy API keys'));
  await choose(root.host, 'Each machine');
  await click(button(root.host, 'Done'));
  await flush();
  assert.deepEqual(named('host.removeApiKey'), [
    ['host.removeApiKey', 'anthropic'],
    ['host.removeApiKey', 'openai'],
  ]);
  assert.equal(named('host.removeOrgAccess').length, 1, 'the organization was already gone');
  assert.equal(value(root.host), 'Each machine');
});

test('My organization: Sign in waits for a sign-in URL, saves trimmed fields and the hours, then signs in; More holds the rest', async (t) => {
  const root = await opened();
  t.after(() => root.unmount());
  await choose(root.host, 'My organization');
  assert.equal(input(root.host, 'Client ID'), null, 'under More');
  assert.match(text(root.host), /More: client ID, OpenAI gateway, session length \(8 h\)/);
  assert.equal(button(root.host, 'Sign in').disabled, true);
  await setValue(input(root.host, 'Sign-in URL')!, `  ${CONFIG.issuer} `);
  await setValue(input(root.host, 'Gateway URL')!, 'https://llm.example.com/anthropic ');
  await click(button(root.host, 'More: client ID, OpenAI gateway, session length (8 h)'));
  await setValue(input(root.host, 'Client ID')!, ' mopilot ');
  await setValue(input(root.host, 'Session length in hours')!, '6');
  let signedIn: (v: unknown) => void = () => undefined;
  responses['host.orgSignIn'] = () => new Promise((r) => (signedIn = r));
  await click(button(root.host, 'Sign in'));
  await flush();
  assert.deepEqual(named('host.setOrgAccess'), [
    [
      'host.setOrgAccess',
      { ...CONFIG, access: { kind: 'gateway', gateways: { anthropic: CONFIG.access.gateways.anthropic, openai: undefined } } },
    ],
  ]);
  assert.equal(button(root.host, 'Signing in…').disabled, true);
  await act(async () => signedIn(org('signedIn')));
  await flush();
  assert.equal(root.host.querySelector('.dialog'), null);
  assert.equal(value(root.host), 'My organization');
});

test('signed in: Done closes, Sign out signs out; an edit asks to sign in again; set up but signed out signs in without saving', async (t) => {
  responses['host.orgAccess'] = () => Promise.resolve(org('signedIn'));
  const root = await render(h(HostSigninMethod));
  t.after(() => root.unmount());
  await flush();
  await click(button(root.host, 'How machines sign inMy organization'));
  assert.match(text(root.host), /Signed in as ada@example\.com/);
  assert.equal(input(root.host, 'Sign-in URL')!.value, CONFIG.issuer);
  await click(button(root.host, 'Sign out'));
  await flush();
  assert.equal(named('host.orgSignOut').length, 1);
  assert.match(text(root.host), /Not signed in on this Mac\./);
  // set up, signed out, nothing changed: Sign in only signs in
  await click(button(root.host, 'Sign in'));
  await flush();
  assert.equal(named('host.setOrgAccess').length, 0);
  assert.equal(named('host.orgSignIn').length, 1);
  await click(button(root.host, 'How machines sign inMy organization'));
  await click(button(root.host, 'Done'));
  assert.equal(root.host.querySelector('.dialog'), null);
  // an edit is saved first; a save that comes back signed in is not signed in again
  responses['host.setOrgAccess'] = () => Promise.resolve(org('signedIn'));
  await click(button(root.host, 'How machines sign inMy organization'));
  await setValue(input(root.host, 'Gateway URL')!, 'https://llm2.example.com');
  await click(button(root.host, 'Sign in'));
  await flush();
  assert.equal(named('host.setOrgAccess').length, 1);
  assert.equal(named('host.orgSignIn').length, 1);
});

test('a refused organization setting is a toast and opens More; a failed read is a toast too', async (t) => {
  responses['host.orgAccess'] = () => Promise.reject(new Error('Host is off.'));
  responses['host.apiKeys'] = () => Promise.reject(new Error('Keys are locked.'));
  // nothing answered: the row names no choice, and the sheet opens on Each machine
  const root = await opened('How machines sign in');
  assert.equal(checked(root.host), 'Each machine');
  t.after(() => root.unmount());
  await flush();
  assert.deepEqual(toasts().slice(0, 2).sort(), [
    ['Host is off.', 'error'],
    ['Keys are locked.', 'error'],
  ]);
  await choose(root.host, 'My organization');
  responses['host.setOrgAccess'] = () => Promise.reject(new Error('Give the client id.'));
  await setValue(input(root.host, 'Sign-in URL')!, CONFIG.issuer);
  await click(button(root.host, 'Sign in'));
  await flush();
  assert.deepEqual(toasts().at(-1), ['Give the client id.', 'error']);
  assert.ok(input(root.host, 'Client ID'), 'More opened');
});

test('reads that answer after the row is gone change nothing; a keys answer that is not a map is none', async () => {
  let keys: (v: unknown) => void = () => undefined;
  let orgRead: (v: unknown) => void = () => undefined;
  let keysFail: (e: unknown) => void = () => undefined;
  responses['host.apiKeys'] = () => new Promise((r) => (keys = r));
  responses['host.orgAccess'] = () => new Promise((r) => (orgRead = r));
  const gone = await render(h(HostSigninMethod));
  gone.unmount();
  await act(async () => (keys({ anthropic: '…abcd' }), orgRead(org('signedIn'))));
  responses['host.apiKeys'] = () => new Promise((_r, j) => (keysFail = j));
  const failed = await render(h(HostSigninMethod));
  failed.unmount();
  await act(async () => keysFail(new Error('late')));
  assert.deepEqual(toasts(), [['Late.', 'error']], 'the failure is still said');
  responses['host.apiKeys'] = () => Promise.resolve(null);
  responses['host.orgAccess'] = () => Promise.resolve(OFF);
  const root = await render(h(HostSigninMethod));
  await flush();
  assert.equal(value(root.host), 'Each machine');
  root.unmount();
});

test('the helpers: a draft from nothing, what changed, the state line, a trimmed save, and only typed keys saved', async () => {
  assert.deepEqual(orgDraft(null), { issuer: '', clientId: '', anthropic: '', openai: '', hours: '8' });
  const v = org('signedIn') as any;
  assert.equal(orgChanged(orgDraft(v), v), false);
  assert.equal(orgChanged({ ...orgDraft(v), hours: '7' }, v), true);
  assert.equal(orgState(org('signedIn', null) as any), 'Signed in');
  assert.equal(orgState(org('signinRequired') as any), 'Sign-in ended. Sign in again.');
  await saveOrg({ issuer: ' a ', clientId: ' b ', anthropic: ' ', openai: ' o ', hours: '3' });
  assert.deepEqual(named('host.setOrgAccess').at(-1), [
    'host.setOrgAccess',
    { issuer: 'a', clientId: 'b', leaseHours: 3, access: { kind: 'gateway', gateways: { anthropic: undefined, openai: 'o' } } },
  ]);
  const saved: string[][] = [];
  await saveKeys({ anthropic: ' ', openai: ' sk-1234 ' }, (id, hint) => saved.push([id, hint]));
  assert.deepEqual(saved, [['openai', '…1234']]);
});

test('a refusal partway keeps what main already did: a saved key shows as saved, a removed one as gone', async (t) => {
  responses['host.setApiKey'] = (p: string, k: string) =>
    p === 'openai' ? Promise.reject(new Error('Not an OpenAI key.')) : Promise.resolve(`…${k.slice(-4)}`);
  const root = await opened();
  t.after(() => root.unmount());
  await choose(root.host, 'My API keys');
  await setValue(input(root.host, 'Anthropic key')!, KEY);
  await setValue(input(root.host, 'OpenAI key')!, 'bad');
  await click(button(root.host, 'Done'));
  await flush();
  assert.deepEqual(toasts().at(-1), ['Not an OpenAI key.', 'error']);
  assert.match(text(root.host), /Anthropic key · saved \(…abcd\)/);
  assert.equal(input(root.host, 'OpenAI key')!.value, 'bad', 'the refused one is kept to fix');
  assert.equal(value(root.host), 'My API keys');
  // removing both, the second refused: the first is gone, the second stays
  responses['host.setApiKey'] = (_p: string, k: string) => Promise.resolve(`…${k.slice(-4)}`);
  await setValue(input(root.host, 'OpenAI key')!, 'sk-9999');
  await click(button(root.host, 'Done'));
  await flush();
  responses['host.removeApiKey'] = (p: string) => (p === 'openai' ? Promise.reject(new Error('Locked.')) : Promise.resolve(true));
  await click(button(root.host, 'How machines sign inMy API keys'));
  await choose(root.host, 'Each machine');
  await click(button(root.host, 'Done'));
  await flush();
  assert.deepEqual(toasts().at(-1), ['Locked.', 'error']);
  await choose(root.host, 'My API keys');
  assert.doesNotMatch(text(root.host), /Anthropic key · saved/);
  assert.match(text(root.host), /OpenAI key · saved \(…9999\)/);
});

test('Sign out everywhere forgets the keys here: the row goes back to Each machine', async (t) => {
  responses['host.apiKeys'] = () => Promise.resolve({ anthropic: '…abcd' });
  const root = await render(h(HostSigninMethod));
  t.after(() => root.unmount());
  await flush();
  assert.equal(value(root.host), 'My API keys');
  await click(button(root.host, 'Sign out everywhere'));
  await click(button(root.host, 'Sign out'));
  await flush();
  assert.equal(value(root.host), 'Each machine');
});

test('W4: managed organization settings show locked with who manages them, the other choices are off, and Sign in needs nothing typed', async (t) => {
  const managed = { organization: 'Acme', problem: '' };
  responses['host.orgAccess'] = () => Promise.resolve({ ...org('signedOut', null), managed });
  responses['host.orgSignIn'] = () => Promise.resolve({ ...org('signedIn'), managed });
  const root = await render(h(HostSigninMethod));
  t.after(() => root.unmount());
  await flush();
  await click(button(root.host, 'How machines sign inMy organization'));
  assert.equal(checked(root.host), 'My organizationManaged');
  assert.match(text(root.host), /Managed by Acme\./);
  const radios = [...root.host.querySelectorAll('[role=radio]')] as HTMLButtonElement[];
  assert.deepEqual(
    radios.map((r) => r.disabled),
    [true, true, false],
  );
  for (const label of ['Sign-in URL', 'Gateway URL', 'Client ID', 'OpenAI gateway URL', 'Session length in hours']) {
    assert.equal(input(root.host, label)!.readOnly, true, `${label} is locked`);
  }
  assert.equal(input(root.host, 'Client ID')!.value, 'mopilot', 'the values show, not hidden under More');
  assert.equal(button(root.host, 'Sign in').disabled, false);
  await click(button(root.host, 'Sign in'));
  await flush();
  assert.equal(named('host.setOrgAccess').length, 0, 'nothing is saved: the policy decides');
  assert.equal(named('host.orgSignIn').length, 1);
});

test('W4: a policy change the app did not take is shown beside who manages the settings', async (t) => {
  responses['host.orgAccess'] = () =>
    Promise.resolve({ ...org('signedOut', null), managed: { organization: '', problem: 'The managed policy file is not valid.' } });
  const root = await render(h(HostSigninMethod));
  t.after(() => root.unmount());
  await flush();
  await click(button(root.host, 'How machines sign inMy organization'));
  assert.match(text(root.host), /Managed by your organization\. The managed policy file is not valid\./);
});
