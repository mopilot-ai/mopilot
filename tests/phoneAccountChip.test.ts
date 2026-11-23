// The account chip: the Mac names a chat's login in chats.recent only where its harness has several to tell apart, and the phone shows it on the chat row (never as a fixed row in an open chat).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
import { accountChip } from '../mobile/src/presentation/chatChips';

const require = createRequire(import.meta.url);
const { CapsService } = require('../electron/session/caps.cjs');
const { createChromePanel } = require('../electron/app/chromePanel.cjs');
const appPath = '../mobile/src/MobileApp';
const { MobileApp } = await import(appPath);

test('the chip is the login trimmed and kept short, and absent for anything that is not a name', () => {
  assert.equal(accountChip(' me@x.com '), 'me@x.com');
  assert.equal(accountChip('a'.repeat(60)), `${'a'.repeat(39)}…`);
  // a long address keeps its domain, which is what tells two logins apart
  assert.equal(accountChip(`${'n'.repeat(50)}@work.example.com`), `${'n'.repeat(39 - '@work.example.com'.length)}…@work.example.com`);
  assert.equal(
    accountChip(`${'n'.repeat(20)}@${'d'.repeat(30)}.com`),
    `${'n'.repeat(20)}@${'d'.repeat(30)}.com`.slice(0, 39) + '…',
    'a domain too long to keep is cut like any name',
  );
  for (const none of [undefined, null, '', '   ', 5, {}]) assert.equal(accountChip(none), null);
});

test('the Mac names the login only where the harness has several logins to tell apart', () => {
  const refs: Record<string, any> = {
    cl: { kind: 'claude', key: 'claude:s' },
    cx: { kind: 'codex', key: 't1' },
    cx2: { kind: 'codex', key: 't2' },
    acp: { kind: 'acp:goose', key: 'g' },
  };
  const login = (account: string, label: string | null, over: object = {}) => ({
    harness: 'claude',
    account,
    label,
    kind: 'harnessAuth',
    status: 'ok',
    active: false,
    ...over,
  });
  const instances: Record<string, any[]> = {
    claude: [login('default', 'me@x.com', { active: true }), login('meg', 'meg@x.com')],
    codex: [login('default', 'cx@x.com', { harness: 'codex', active: true }), login('work', 'work@x.com', { harness: 'codex' })],
    acp: [login('a', 'a'), login('b', 'b')],
  };
  const pins: Record<string, any> = { t1: { label: 'work@x.com' }, t2: null };
  const caps = () =>
    new CapsService({
      ref: (id: string) => refs[id] ?? null,
      instances: (h: string) => instances[h] ?? [],
      chatInstance: (_h: string, key: string) => pins[key],
      claudeLogin: () => 'meg',
    });
  const s = caps();
  assert.equal(s.accountChip('cl'), 'meg@x.com', 'two Claude Code logins: this chat’s');
  assert.equal(s.accountChip('cx'), 'work@x.com', 'two Codex accounts and this chat is pinned to one');
  assert.equal(s.accountChip('cx2'), null, 'a Codex chat with no account of its own has none to name');
  assert.equal(s.accountChip('acp'), null, 'a basic harness has no account of its own');
  assert.equal(s.accountChip('nope'), null, 'a chat main does not know');
  // the default login is the active one: a chat that picked another is not on it, and one with no account to name has no default either
  assert.equal(s.accountIsDefault('cl'), false, 'this Claude Code chat picked meg, the default is the other');
  assert.equal(s.accountIsDefault('cx'), false, 'this Codex chat is pinned to work, the default is the other');
  assert.equal(s.accountIsDefault('cx2'), true, 'a Codex chat with no pin runs on the active account');
  assert.equal(s.accountIsDefault('acp'), false);
  assert.equal(s.accountIsDefault('nope'), false);
  const onDefault = new CapsService({
    ref: (id: string) => refs[id] ?? null,
    instances: (h: string) => instances[h] ?? [],
    claudeLogin: () => null,
  });
  assert.equal(onDefault.accountIsDefault('cl'), true, 'a Claude Code chat that picked nothing runs on the active login');
  assert.equal(new CapsService({ ref: () => refs.cx, instances: () => instances.codex }).accountChip('cx'), null, 'no pins to read');
  // the key setting, MoPilot credits and a login signed out with nothing known of it are not accounts to tell apart
  instances.claude = [
    login('default', 'me@x.com', { active: true }),
    login('apiKey', 'API key', { kind: 'sageKey', billing: 'apiKey' }),
    login('mopilot', 'MoPilot credits', { kind: 'sageKey', billing: 'credits' }),
    login('gone', null, { status: 'signedOut' }),
  ];
  assert.equal(s.accountChip('cl'), null, 'one login beside a key and credits');
  // Codex: an API-key account of its own is one to tell apart, MoPilot credits is not
  const codex = (account: string, over: object) => login(account, account, { harness: 'codex', ...over });
  instances.codex = [codex('default', {}), codex('credits', { kind: 'sageKey', billing: 'credits' })];
  assert.equal(s.accountChip('cx'), null, 'one Codex login beside credits');
  instances.codex.push(codex('key', { kind: 'sageKey', billing: 'apiKey' }));
  assert.equal(s.accountChip('cx'), 'work@x.com', 'a Codex API-key account counts');
  instances.claude.push(login('old', null, { status: 'signedOut', active: true }));
  assert.equal(s.accountChip('cl'), 'me@x.com', 'a signed-out login that is the one in use counts');
  instances.claude = [login('default', null, { status: 'signedOut' }), login('meg', 'meg@x.com', { status: 'signedOut' })];
  assert.equal(s.accountChip('cl'), null, 'one login with a name, the other nothing: not several');
});

function panelWith(
  capsService: any,
  sessions: { key: string; title: string; cwd: string; at: number }[] = [{ key: 'th-1', title: 'Flights', cwd: '/tmp', at: 3000 }],
) {
  const records = new Map<string, any>([['th-1', { segments: [{ kind: 'codex', nativeId: 'th-1' }], meta: {} }]]);
  const live: any = {
    chats: { records, patchMeta: () => false, get: (id: string) => ({ id }) },
    controller: { state: { get: () => undefined, has: () => false }, chatOf: (k: string) => k, ref: () => undefined },
    acpAdmission: { list: () => [], admitted: () => false },
    capsService,
  };
  const panel = createChromePanel({
    live,
    claude: {},
    sources: { codex: async () => sessions },
    projectsFile: '/nonexistent/projects.json',
    home: '/tmp',
    prefs: () => ({}),
    usable: async () => true,
    starter: { prefs: () => ({}), chats: live.chats, started: () => undefined },
    send: async () => ({ action: 'started', id: 'x' }),
    open: () => undefined,
    scheduled: async () => [],
    broadcast: () => undefined,
  });
  return (limit = 50) => new Promise<any>((resolve) => void panel.handle({ id: 1, method: 'recent', params: { limit } }, resolve));
}

test('chats.recent carries the account chip when the Mac names one, and leaves it out otherwise or when reading it fails', async () => {
  const named = await panelWith({ accountChip: (id: string) => (id === 'th-1' ? 'work@x.com' : null) })();
  assert.equal(named.result.chats[0].account, 'work@x.com');
  const none = await panelWith({ accountChip: () => null })();
  assert.equal('account' in none.result.chats[0], false, 'additive: an old phone and a one-account Mac see nothing new');
  const absent = await panelWith(undefined)();
  assert.equal('account' in absent.result.chats[0], false);
  const failing = await panelWith({
    accountChip: () => {
      throw new Error('instances unavailable');
    },
  })();
  assert.equal('account' in failing.result.chats[0], false, 'a failed read costs the chip, not the list');
  // the row says whether the login is the computer's default, so the phone need not repeat it on every row
  const dflt = await panelWith({ accountChip: () => 'me@x.com', accountIsDefault: () => true })();
  assert.deepEqual([dflt.result.chats[0].account, dflt.result.chats[0].accountDefault], ['me@x.com', true]);
  const other = await panelWith({ accountChip: () => 'meg@x.com', accountIsDefault: () => false })();
  assert.equal('accountDefault' in other.result.chats[0], false, 'additive: only a default login is flagged');
  const unknown = await panelWith({ accountChip: () => 'me@x.com' })();
  assert.equal('accountDefault' in unknown.result.chats[0], false, 'a Mac that cannot say flags nothing');
  const broken = await panelWith({
    accountChip: () => 'me@x.com',
    accountIsDefault: () => {
      throw new Error('instances unavailable');
    },
  })();
  assert.deepEqual(
    [broken.result.chats[0].account, 'accountDefault' in broken.result.chats[0]],
    ['me@x.com', false],
    'a failed read costs the flag, not the row',
  );
});

test('chats.recent tells two projects of one name apart by their parent folders, and says nothing of a project whose name is its own', async () => {
  const sessions = [
    { key: 'th-1', title: 'In x', cwd: '/tmp/x/app', at: 3000 },
    { key: 'th-2', title: 'In y', cwd: '/tmp/y/app', at: 2000 },
    { key: 'th-3', title: 'Alone', cwd: '/tmp/docs', at: 1000 },
  ];
  const { result } = await panelWith(undefined, sessions)();
  const by = (id: string) => result.chats.find((c: any) => c.id === id);
  assert.deepEqual([by('th-1').projectHint, by('th-2').projectHint], ['x', 'y']);
  assert.equal('projectHint' in by('th-3'), false, 'additive: only a shared name has one');
  assert.doesNotMatch(
    JSON.stringify(result.chats.map((c: any) => c.projectHint)),
    /tmp/,
    'the parent folders that tell them apart, not the path',
  );
});

const online = {
  phase: 'online',
  generation: 1,
  user: { id: 'u' },
  pairs: [{ pairId: 'p2', macId: 'm2', name: 'Mac two' }],
  selectedPair: 'p2',
  safetyNumber: null,
  pendingPair: false,
  error: null,
};

test('the phone shows the login chip on the chat row but not as a fixed row in the open chat, and none for a chat without one', async () => {
  const s = scripted(
    (m) =>
      m === 'chats.recent'
        ? {
            chats: [
              { id: 'c1', title: 'Fix the build', harness: 'claude', account: 'work@x.com' },
              { id: 'c2', title: 'Plan the trip', harness: 'codex' },
            ],
          }
        : undefined,
    online,
  );
  s.runtime.start = async () => {};
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime })));
  await flush();
  const open = async (title: string) => {
    const button = [...host.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === `Open chat ${title}`)!;
    await act(async () => button.click());
    await flush();
  };
  assert.equal((host.textContent!.match(/work@x\.com/g) ?? []).length, 1, 'one chip, on the chat that has a login to name');
  assert.equal(host.querySelectorAll('[aria-valuetext*="Account work@x.com"]').length, 1, 'a screen reader is told it is an account');
  assert.equal(host.querySelectorAll('[aria-valuetext*="Account"]').length, 1, 'and only for the chat that has one');
  await open('Fix the build');
  assert.doesNotMatch(host.textContent!, /work@x\.com/, 'the open chat has no fixed account row under its header');
  assert.equal(host.querySelectorAll('[aria-label="Account work@x.com"]').length, 0);
  const back = [...host.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Back to chats')!;
  await act(async () => back.click());
  await flush();
  await open('Plan the trip');
  assert.doesNotMatch(host.textContent!, /work@x\.com/, 'another chat shows no chip');
  await act(async () => root.unmount());
  host.remove();
});
