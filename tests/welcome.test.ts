// The welcome page's decisions (src/lib/welcome.ts): the order of its list, how an agent connects, and which one
// new chats start with.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  welcomeDue,
  FIRST_CLASS,
  connectMethods,
  featuredFirst,
  firstPresence,
  basicPresence,
  rankAgents,
  setupNeed,
  launchKind,
  launchGate,
  connectedKinds,
  joinedSince,
  startWith,
  basicKind,
} = await import('../src/lib/welcome.ts');

test('Claude Code is listed before Codex; each connects with its subscription, an API key or credits', () => {
  assert.deepEqual(FIRST_CLASS, ['claude', 'codex']);
  assert.deepEqual(connectMethods({ subscription: 'ChatGPT account', subscriptionPlans: 'ChatGPT Plus', vendor: 'OpenAI' }), [
    { pay: 'subscription', label: 'ChatGPT account', hint: 'Use your ChatGPT Plus plan.' },
    { pay: 'apikey', label: 'API key', hint: 'Pay OpenAI per use with your own key.' },
    { pay: 'mopilot', label: 'MoPilot credits', hint: 'Pay as you go with credits from your MoPilot account.' },
  ]);
  // a build without the MoPilot service offers no credits
  assert.deepEqual(
    connectMethods({ subscription: 'ChatGPT account', subscriptionPlans: 'ChatGPT Plus', vendor: 'OpenAI' }, false).map((m) => m.pay),
    ['subscription', 'apikey'],
  );
});

test("a basic harness's kind is its id under acp:", () => {
  assert.equal(basicKind('gemini'), 'acp:gemini');
});

test('the basic harnesses most people pay for come first, the rest in the order given', () => {
  const basics = ['acp:dsh', 'acp:gemini', 'acp:copilot', 'acp:kimi', 'acp:cursor'].map((kind) => ({ kind }));
  assert.deepEqual(
    featuredFirst(basics).map((b) => b.kind),
    ['acp:copilot', 'acp:cursor', 'acp:gemini', 'acp:dsh', 'acp:kimi'],
  );
});

test('where an agent stands on this Mac', () => {
  assert.equal(firstPresence('signin', true), 'connected');
  assert.equal(firstPresence('missing', false), 'missing');
  assert.equal(firstPresence('signin', false), 'installed');
  assert.equal(firstPresence('detecting', false), 'installed', 'one still being detected is not hidden');
  assert.equal(basicPresence('admitted'), 'connected');
  assert.equal(basicPresence('missing'), 'missing');
  // main probes only a binary it found, and a re-check marks an installed one checking: it stays installed
  for (const s of ['checking', 'signin', 'unsupported', 'off']) assert.equal(basicPresence(s), 'installed');
});

test('the list: connected, installed, missing, each in the given order; only missing basic ones fold', () => {
  const a = (kind: string, tier: 'first' | 'basic', presence: 'connected' | 'installed' | 'missing') => ({ kind, tier, presence });
  const { shown, more } = rankAgents([
    a('claude', 'first', 'missing'),
    a('codex', 'first', 'installed'),
    a('acp:copilot', 'basic', 'missing'),
    a('acp:gemini', 'basic', 'connected'),
    a('acp:kimi', 'basic', 'installed'),
    a('acp:goose', 'basic', 'missing'),
  ]);
  assert.deepEqual(
    shown.map((x) => x.kind),
    ['acp:gemini', 'codex', 'acp:kimi', 'claude'],
  );
  assert.deepEqual(
    more.map((x) => x.kind),
    ['acp:copilot', 'acp:goose'],
  );
  assert.deepEqual(rankAgents([]), { shown: [], more: [] });
});

test('what stands between the user and a working harness', () => {
  assert.equal(setupNeed('detecting', false), 'checking');
  assert.equal(setupNeed('missing', false), 'install');
  assert.equal(setupNeed('signin', false), 'credential');
  // installed but broken (keeps quitting, unusable version): its settings, not a sign-in
  assert.equal(setupNeed('error', false), 'broken');
  // a credential it refused (a key, credits): connecting another fixes it
  assert.equal(setupNeed('error', false, true), 'credential');
  assert.equal(setupNeed('ready', true), 'ready');
  assert.equal(setupNeed('apikey', true), 'ready');
});

test('first launch: first-class ready, only basic harnesses, or nothing', () => {
  assert.equal(launchKind(false, true, 0), 'ready');
  assert.equal(launchKind(true, false, 2), 'ready');
  assert.equal(launchKind(false, false, 1), 'basic-only');
  assert.equal(launchKind(false, false, 0), 'nothing');
});

test('connected agents, in the page order: usable first-class ones, then admitted basic ones', () => {
  assert.deepEqual(
    connectedKinds({ claude: false, codex: true }, [
      { id: 'gemini', state: 'admitted' },
      { id: 'kimi', state: 'signin' },
    ]),
    ['codex', 'acp:gemini'],
  );
  assert.deepEqual(connectedKinds({ claude: true, codex: true }, []), ['claude', 'codex']);
});

test('new chats start with the first agent connected on the page, else the first connected', () => {
  // nothing new since the page opened: the joined list stays the same object
  const none: string[] = [];
  assert.equal(joinedSince(none as any, ['claude'], ['claude']), none);
  // Codex, then Claude Code, connect while the page is open; Gemini was connected before
  let joined = joinedSince([], ['codex', 'acp:gemini'], ['acp:gemini']);
  joined = joinedSince(joined, ['claude', 'codex', 'acp:gemini'], ['acp:gemini']);
  assert.deepEqual(joined, ['codex', 'claude']);
  assert.equal(startWith(['claude', 'codex', 'acp:gemini'], joined, 'acp:gemini'), 'codex', 'one connected here wins');
  // Codex stops working: the next one connected here
  assert.equal(startWith(['claude', 'acp:gemini'], joined, 'acp:gemini'), 'claude');
  // none connected here: the default the user has while it is connected, else the first connected; none at all: null
  assert.equal(startWith(['acp:kimi', 'acp:gemini'], [], 'acp:gemini'), 'acp:gemini');
  assert.equal(startWith(['acp:gemini'], [], 'claude'), 'acp:gemini');
  assert.equal(startWith([], [], 'claude'), null);
});

test('the welcome page opens while nothing works, or on a new install while only a basic harness does (#2034)', () => {
  const due = (o: Partial<Parameters<typeof welcomeDue>[0]>) =>
    welcomeDue({ checking: false, anyUsable: true, firstClassUsable: false, welcomeDone: false, ...o });
  assert.equal(due({ anyUsable: false, firstClassUsable: false }), true, 'nothing works');
  assert.equal(due({ anyUsable: false, welcomeDone: true }), true, 'nothing works, even once finished');
  assert.equal(due({}), true, 'only a basic harness, on a new install');
  assert.equal(due({ welcomeDone: true }), false, 'finished, or an install from before the page');
  assert.equal(due({ firstClassUsable: true }), false, 'Codex or Claude Code works');
  assert.equal(due({ checking: true, anyUsable: false }), false, 'still looking');
  assert.equal(due({ dismissed: true }), false, 'left for Settings this launch');
  assert.equal(due({ anyUsable: false, dismissed: true }), true, 'nothing works, even then');
});

test('what the window shows: the welcome page while open, the app once usable, the launch while looking until capped', () => {
  const gate = (o: Partial<{ welcoming: boolean; showApp: boolean; checking: boolean; capped: boolean }>) =>
    launchGate({ welcoming: false, showApp: false, checking: false, capped: false, ...o });
  assert.equal(gate({ welcoming: true, showApp: true }), 'welcome', 'the page stays until its last step');
  assert.equal(gate({ showApp: true, checking: true }), 'app');
  assert.equal(gate({ checking: true }), 'checking');
  // looking for the agents has taken long: the welcome list, its rows still checking
  assert.equal(gate({ checking: true, capped: true }), 'welcome');
  assert.equal(gate({}), 'welcome');
});
