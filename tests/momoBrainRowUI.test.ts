// Setup's brain (src/components/momo/setup/BrainRow.tsx, #2527, #2607): the brain MoMo starts on, chosen for the user from the signed-in harnesses of every family (the account with the most remaining capacity on its harness's everyday model; accounts at their limit, API keys MoMo can't use, signed-out and lapsed logins never chosen), said in words for the Meet footnote, and what setup says when nothing can be chosen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act } from 'react';
import { render, click, byText, flush, fakeStore } from './support/shell-chrome-kit.ts';
import { mockSource, stubStore } from './support/stubs.ts';

const store = fakeStore<any>({ basicHarnesses: [] });
let bridge: any;
mockSource('src/lib/momoBridges.ts', { momoChatBridge: () => bridge });
const routes: any[] = [];
stubStore({ useStore: store.useStore, navigate: (r: any) => routes.push(r) });
let enabled = ['codex', 'claude'];
mockSource('src/lib/flags.ts', { useEnabledHarnesses: () => enabled });
const row = (id: string, name: string, o: any = {}) => ({
  key: `${o.h}:${id}`,
  account: { id, left: o.left ?? null, kind: o.kind ?? 'subscription' },
  name,
  plan: o.plan ?? null,
  state: o.state ?? 'signed-in',
  status: { text: o.status ?? '', tone: o.tone ?? 'ok' },
  short: o.short ?? null,
});
let views: Record<string, any> = {};
mockSource('src/session/harness/useAccountView.ts', { useAccountView: (hh: string) => views[hh] });
let noModels = false;
mockSource('src/session/harness/select.ts', {
  useHarnessModels: (hh: string) =>
    noModels
      ? []
      : hh === 'claude'
        ? [
            { id: 'haiku', label: 'Haiku' },
            { id: 'opus', label: 'Opus', isDefault: true },
            { id: 'sonnet', label: 'Sonnet' },
          ]
        : hh === 'codex'
          ? [
              { id: 'gpt-6-pro', label: 'GPT-6 Pro' },
              { id: 'gpt-6', label: 'GPT-6', isDefault: true },
            ]
          : [],
});
mockSource('src/session/harness/acp.ts', { basicLabel: (id: string) => `Basic ${id}` });
mockSource('src/components/momo/settings/BrainPicker.tsx', {
  firstTierOf: (k: string) => (k === 'codex' || k === 'claude' ? k : null),
});

const { NoBrain, brainText, useSetupBrain, MODELS_WAIT_MS, DETECT_WAIT_MS } = await import('../src/components/momo/setup/BrainRow.tsx');
let shown: any = 'unset';
let ready: any = null;
function Setup() {
  const s = useSetupBrain();
  shown = s.shown;
  ready = s.ready;
  return h(
    'div',
    null,
    s.probes,
    s.shown ? h('span', { className: 'label' }, brainText(s.shown)) : h(NoBrain, { allLimited: s.allLimited }),
  );
}
const label = (host: HTMLElement) => host.querySelector('.label')?.textContent;
const BASICS = [
  { id: 'gemini', label: 'Gemini CLI', state: 'admitted', isolates: true },
  { id: 'kimi', state: 'admitted', isolates: true },
  // admitted, but its own tools can't be turned off: never offered for MoMo (#2278)
  { id: 'qwen', state: 'admitted' },
  // confined, but with free models only: not offered either (#2357)
  { id: 'opencode', state: 'admitted', isolates: true, momoBlocked: 'MoMo needs an opencode provider' },
  { id: 'goose', label: 'Goose', state: 'missing' },
];

function everyFamily() {
  enabled = ['codex', 'claude'];
  views = {
    // left idle until its first use: its accounts are known
    codex: {
      phase: 'not-started',
      accounts: [
        row('team', 'team', { h: 'codex', plan: 'Business', left: 69 }),
        row('old', 'old', { h: 'codex', state: 'lapsed' }),
        row('personal', 'personal', { h: 'codex', plan: 'Plus', left: 91 }),
        row('capped', 'capped', { h: 'codex', state: 'limited', left: 0 }),
      ],
    },
    claude: {
      phase: 'ready',
      accounts: [
        row('work', 'du@work', { h: 'claude', plan: 'Claude Max', left: 82 }),
        row('key', 'API key', { h: 'claude', state: 'billed', kind: 'apiKey' }),
        // per use whatever its state says: an API key still being checked, MoPilot credits
        row('key2', 'Second key', { h: 'claude', state: 'checking', kind: 'apiKey', left: 100 }),
        row('credits', 'MoPilot', { h: 'claude', plan: 'MoPilot credits', left: 100 }),
        row('who', 'who@x', { h: 'claude', state: 'unverified', left: 100 }),
        row('home', 'du@home', { h: 'claude', plan: 'Claude Pro', left: 96, state: 'checking' }),
      ],
    },
  };
  store.setState({ basicHarnesses: BASICS });
  noModels = false;
}

test('the default is the account with the most remaining capacity on its harness’s everyday model; one at its limit, a key or a lapsed login never', async () => {
  everyFamily();
  const { host, unmount } = await render(h(Setup));
  // Max (5×) at 82% = 410 beats Pro at 96% and Plus at 91%; Sonnet, not the list's default Opus
  assert.deepEqual(shown, { harness: 'claude', account: 'work', model: 'sonnet', modelLabel: 'Sonnet' });
  assert.equal(label(host), 'Claude Code · Sonnet', 'the footnote says the harness and the model');
  // the same accounts, but the plan sizes say otherwise: Plus (1×) at 91% against a Pro Lite at 87% and a Max 20× at 83%
  views.codex = {
    phase: 'ready',
    accounts: [
      row('lite', 'lite', { h: 'codex', plan: 'Pro Lite', left: 87 }),
      row('plus', 'plus', { h: 'codex', plan: 'Plus', left: 91 }),
    ],
  };
  views.claude = { phase: 'ready', accounts: [row('big', 'big', { h: 'claude', plan: 'Claude Max 20×', left: 83 })] };
  await act(async () => store.setState({ basicHarnesses: [...BASICS] }));
  assert.equal(shown.account, 'big');
  // Claude out of the picture: Codex's Pro Lite (435) over Plus (91), on the model its list marks as the everyday default
  views.claude = { phase: 'signed-out', accounts: [] };
  await act(async () => store.setState({ basicHarnesses: [...BASICS] }));
  assert.deepEqual(shown, { harness: 'codex', account: 'lite', model: 'gpt-6', modelLabel: 'GPT-6' });
  await unmount();
});

test('a harness with no models starts on its own; a basic harness is the choice only when nothing else is signed in', async () => {
  everyFamily();
  noModels = true;
  const one = await render(h(Setup));
  assert.deepEqual(shown, { harness: 'claude', account: 'work', model: null, modelLabel: null });
  await one.unmount();
  noModels = false;
  views = { codex: { phase: 'signed-out', accounts: [] }, claude: { phase: 'missing', accounts: [] } };
  const basic = await render(h(Setup));
  // Gemini and Kimi are confined; qwen is not, opencode has no provider, Goose is not installed
  assert.deepEqual(shown, { harness: 'acp:gemini', account: null, model: null, modelLabel: null });
  assert.equal(label(basic.host), 'Basic gemini', 'a basic harness has no model to name');
  await basic.unmount();
});

test('nothing signed in (signed out, turned off, only lapsed logins, no basic harness): why, and a way to sign in', async () => {
  views = { codex: { phase: 'signed-out', accounts: [] }, claude: { phase: 'ready', accounts: [row('work', 'du@work', { h: 'claude' })] } };
  enabled = ['codex'];
  store.setState({ basicHarnesses: [{ id: 'goose', state: 'missing' }] });
  routes.length = 0;
  const { host, unmount } = await render(h(Setup));
  assert.equal(shown, null);
  assert.match(host.textContent!, /Sign in to an agent first, then come back\./);
  await click(byText(host, 'Open Accounts and billing'));
  assert.deepEqual(routes, [{ name: 'settings', section: 'accounts' }]);
  await unmount();
  // ready with only lapsed logins counts as nothing signed in too
  enabled = ['codex', 'claude'];
  views = {
    codex: { phase: 'ready', accounts: [row('old', 'old', { h: 'codex', state: 'lapsed' })] },
    claude: { phase: 'checking', accounts: [] },
  };
  const lapsed = await render(h(Setup));
  assert.match(lapsed.host.textContent!, /Sign in to an agent first/);
  await lapsed.unmount();
});

test('every signed-in account at its limit: it says so, not that nothing is signed in', async () => {
  enabled = ['codex', 'claude'];
  views = {
    codex: { phase: 'ready', accounts: [row('team', 'team', { h: 'codex', state: 'limited', plan: 'Business', tone: 'warn' })] },
    claude: { phase: 'ready', accounts: [row('key', 'API key', { h: 'claude', state: 'limited', kind: 'apiKey' })] },
  };
  store.setState({ basicHarnesses: [] });
  const { host, unmount } = await render(h(Setup));
  assert.equal(shown, null);
  assert.match(host.textContent!, /All your accounts are at their limit until one resets\./);
  assert.doesNotMatch(host.textContent!, /Sign in to an agent first/);
  assert.ok(byText(host, 'Open Accounts and billing'));
  await unmount();
});

test('#2308: Codex signed in with API keys only says MoMo needs a ChatGPT sign-in there, with or without another harness', async () => {
  noModels = false;
  enabled = ['codex', 'claude'];
  store.setState({ basicHarnesses: [] });
  const key = row('key', 'API key', { h: 'codex', kind: 'apiKey' });
  views = { codex: { phase: 'ready', accounts: [key] }, claude: { phase: 'ready', accounts: [row('work', 'du@work', { h: 'claude' })] } };
  const one = await render(h(Setup));
  assert.equal(one.host.querySelector('.momo-setup-note')?.textContent, 'MoMo needs a ChatGPT sign-in on Codex');
  assert.equal(shown.account, 'work');
  await one.unmount();
  // nothing else signed in: the same line beside the way to sign in
  views = { ...views, claude: { phase: 'signed-out', accounts: [] } };
  const none = await render(h(Setup));
  assert.match(none.host.textContent!, /MoMo needs a ChatGPT sign-in on Codex/);
  assert.match(none.host.textContent!, /Sign in to an agent first/);
  await none.unmount();
  // a ChatGPT sign-in beside the key: no line
  views = { ...views, codex: { phase: 'ready', accounts: [key, row('team', 'Team', { h: 'codex' })] } };
  const both = await render(h(Setup));
  assert.equal(both.host.querySelector('.momo-setup-note'), null);
  await both.unmount();
  // Codex turned off: not asked
  enabled = ['claude'];
  const off = await render(h(Setup));
  assert.equal(off.host.querySelector('.momo-setup-note'), null);
  await off.unmount();
  await flush();
});

test('a brain MoMo already has (setup run again, or one picked before) is kept instead of choosing again; with none the default is chosen', async () => {
  everyFamily();
  const mine = { harness: 'codex', account: 'personal', model: 'gpt-6', modelLabel: 'GPT-6' };
  let asked = 0;
  let reply: (b: any) => void = () => {};
  bridge = { getBrain: () => (asked++, new Promise((r) => (reply = r))) };
  const again = await render(h(Setup));
  assert.equal(ready, false, 'not until MoMo’s own brain is read');
  await act(async () => reply(mine));
  assert.equal(asked, 1);
  assert.deepEqual(shown, mine);
  assert.equal(ready, true);
  await again.unmount();
  // no brain yet, a bridge that fails, or none in this build: the default
  bridge = { getBrain: async () => null };
  const none = await render(h(Setup));
  await flush();
  assert.equal(shown.harness, 'claude');
  assert.equal(ready, true);
  await none.unmount();
  bridge = {
    getBrain: async () => {
      throw new Error('offline');
    },
  };
  const failed = await render(h(Setup));
  await flush();
  assert.equal(shown.harness, 'claude');
  assert.equal(ready, true, 'a failed read does not hold setup');
  await failed.unmount();
  bridge = undefined;
  const bare = await render(h(Setup));
  await flush();
  assert.equal(shown.harness, 'claude');
  await bare.unmount();
  // gone before the answer (or its failure): it is not shown
  let answer: (b: any) => void = () => {};
  bridge = { getBrain: () => new Promise((r) => (answer = r)) };
  const gone = await render(h(Setup));
  await gone.unmount();
  await act(async () => answer(mine));
  let fail: (e: Error) => void = () => {};
  bridge = { getBrain: () => new Promise((_, r) => (fail = r)) };
  const goneFailing = await render(h(Setup));
  await goneFailing.unmount();
  await act(async () => fail(new Error('late')));
  bridge = undefined;
});

test('Continue waits for the default’s model list, a few seconds at most; a harness with models is ready at once', async () => {
  everyFamily();
  noModels = true;
  try {
    const { unmount } = await render(h(Setup));
    assert.equal(shown.model, null);
    assert.equal(ready, false, 'the everyday model can not be named yet');
    await act(async () => void (await new Promise((r) => setTimeout(r, MODELS_WAIT_MS + 100))));
    assert.equal(ready, true, 'a harness with no model list is not waited for for ever');
    await unmount();
  } finally {
    noModels = false;
  }
  const loaded = await render(h(Setup));
  assert.equal(ready, true, 'models listed: the everyday one is named');
  await loaded.unmount();
  // a basic harness has no model list to wait for
  views = { codex: { phase: 'signed-out', accounts: [] }, claude: { phase: 'missing', accounts: [] } };
  const basic = await render(h(Setup));
  assert.equal(ready, true);
  await basic.unmount();
});

test('Continue waits while a harness is still detecting, so the default is chosen over every signed-in one, a few seconds at most', async () => {
  everyFamily();
  // Claude Code still detecting (no accounts yet): Codex alone would be the default if setup did not wait
  const later = views.claude;
  views.claude = { phase: 'checking', accounts: [] };
  const { unmount } = await render(h(Setup));
  assert.equal(shown.harness, 'codex', 'only Codex has reported so far');
  assert.equal(ready, false, 'a harness still detecting holds Continue');
  views.claude = later;
  await act(async () => store.setState({ basicHarnesses: [...BASICS] }));
  assert.equal(shown.harness, 'claude', 'the default is chosen over both once Claude Code reported');
  assert.equal(ready, true);
  await unmount();
  // one that never finishes detecting is waited for a few seconds, not for ever
  views.claude = { phase: 'checking', accounts: [] };
  const stuck = await render(h(Setup));
  assert.equal(ready, false);
  await act(async () => void (await new Promise((r) => setTimeout(r, DETECT_WAIT_MS + 100))));
  assert.equal(ready, true, 'a harness that never answers does not hold setup');
  assert.equal(shown.harness, 'codex');
  await stuck.unmount();
});
