// A basic (ACP) chat's failed turn that asks for a sign-in offers Sign in and Re-check (src/session/chatActions.ts,
// src/session/harness/acp.ts), the same way a Claude Code chat's does; the words are shared with main (shared/acpAuth.mjs).
import { beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { called, fx, reset } from './support/harness-logic-fakes.ts';

mock.module(new URL('../src/session/harness/claude.ts', import.meta.url).href, {
  namedExports: { recheckClaude: () => {}, reloginClaudeAccount: () => {} },
});
const { authRecovery } = await import('../src/session/chatActions.ts');
const { isAuthText } = await import('../shared/acpAuth.mjs');
const { basicAuthRecovery } = await import('../src/session/harness/acp.ts');
const { isAuthError } = createRequire(import.meta.url)('../electron/harness/acp/signin.cjs');

const CHAT = 'acp:kimi:n1';
const SIGNED_OUT = 'Kimi Code: Sign in to Kimi Code first';
const harness = (o: any = {}) => ({
  id: 'kimi',
  label: 'Kimi Code',
  state: 'signin',
  authMethods: [],
  login: null,
  bin: '/bin/kimi',
  ...o,
});
const recheckCalls: any[] = [];
beforeEach(() => {
  reset();
  recheckCalls.length = 0;
  fx.state.home = '/home/ada';
  fx.native.acp = {
    recheck: async (id: string) => (recheckCalls.push(id), [harness({ state: 'admitted' })]),
    authenticate: async (id: string, m: string) => (
      recheckCalls.push(`auth ${id} ${m}`), { harnesses: [harness({ state: 'admitted' })], cancelled: false }
    ),
  };
});

test('the sign-in words: main and the chat read the same failure the same way', () => {
  for (const text of ['Authentication required', 'Not logged in', 'not signed in', 'Login required'])
    assert.equal(isAuthText(text), true, text);
  // a third party's sign-in in the harness's words is not the harness signed out
  for (const text of ['disk full', '', null, undefined, 'sign in', 'tool failed: sign in to GitHub first'])
    assert.equal(isAuthText(text), false, String(text));
  assert.equal(isAuthError(new Error('Not logged in')), true);
  assert.equal(isAuthError({ code: -32000 }), true);
  assert.equal(isAuthError({ code: -32603, message: 'disk full' }), false);
});

test("a basic chat's sign-in failure offers its terminal login, then Re-check", async () => {
  fx.state.basicHarnesses = [harness({ login: ['kimi', 'login'] })];
  assert.equal(authRecovery(CHAT, 'disk full'), null, 'another failure has no sign-in');
  assert.equal(authRecovery(CHAT, 'Kimi Code: sign in to GitHub first'), null, "another service's sign-in is not the harness's");
  assert.equal(authRecovery('codex-1', SIGNED_OUT), null, "Codex's sign-in lapse is the re-verify banner's");
  assert.equal(basicAuthRecovery('codex-1', 'Not logged in'), null, 'not a basic chat');
  const r = authRecovery(CHAT, SIGNED_OUT)!;
  assert.equal(r.label, 'Sign in');
  r.signIn();
  assert.deepEqual(called('openPaneTab'), [
    ['terminal', { command: ['/bin/kimi', 'login'], title: 'Kimi Code login', cwd: '/home/ada', signIn: true }],
  ]);
  r.recheck?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(recheckCalls, ['kimi']);
  assert.equal(fx.state.basicHarnesses[0].state, 'admitted');
});

test("a method's own terminal sign-in comes first; one with none signs in over ACP", async () => {
  const terminal = { id: 'term', name: 'Terminal', _meta: { 'terminal-auth': { command: 'kimi', args: ['auth'], label: 'kimi auth' } } };
  fx.state.basicHarnesses = [harness({ authMethods: [{ id: 'oauth', name: 'Browser' }, terminal] })];
  authRecovery(CHAT, SIGNED_OUT)!.signIn();
  assert.deepEqual(called('openPaneTab'), [
    ['terminal', { command: ['/bin/kimi', 'auth'], title: 'kimi auth', cwd: '/home/ada', signIn: true }],
  ]);
  fx.state.basicHarnesses = [harness({ authMethods: [{ id: 'oauth', name: 'Browser' }] })];
  const r = authRecovery(CHAT, 'Authentication required')!;
  assert.equal(r.label, 'Sign in');
  r.signIn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(recheckCalls, ['auth kimi oauth']);
});

test("ACP's terminal auth method signs a chat in from the side pane, with the env it asks for", () => {
  const typed = { id: 'login', name: 'Login', type: 'terminal', args: ['--login'], env: { KIMI_X: '1' } };
  fx.state.basicHarnesses = [harness({ authMethods: [{ id: 'oauth', name: 'Browser' }, typed] })];
  authRecovery(CHAT, SIGNED_OUT)!.signIn();
  assert.deepEqual(called('openPaneTab'), [
    ['terminal', { command: ['/bin/kimi', '--login'], title: 'Kimi Code login', env: { KIMI_X: '1' }, cwd: '/home/ada', signIn: true }],
  ]);
  // Goose's quirks login (goose configure): its method has no terminal of its own
  reset();
  fx.state.home = '/home/ada';
  fx.state.basicHarnesses = [
    harness({ id: 'goose', label: 'Goose', bin: '/bin/goose', login: ['goose', 'configure'], authMethods: [{ id: 'goose-provider' }] }),
  ];
  authRecovery('acp:goose:n1', 'Goose: Sign in to Goose first')!.signIn();
  assert.deepEqual(called('openPaneTab'), [
    ['terminal', { command: ['/bin/goose', 'configure'], title: 'Goose login', cwd: '/home/ada', signIn: true }],
  ]);
});

test('an unavailable managed terminal sign-in tells the chat to Repair without falling through to ACP', async () => {
  for (const legacy of [false, true]) {
    fx.state.basicHarnesses = [
      harness({
        bin: '/managed/launch',
        authBin: null,
        authMethods: legacy ? [] : [{ id: 'login', name: 'Login', type: 'terminal', args: ['login'] }],
        login: legacy ? ['kimi', 'login'] : null,
      }),
    ];
    authRecovery(CHAT, SIGNED_OUT)!.signIn();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(recheckCalls, []);
    assert.deepEqual(called('openPaneTab'), []);
    assert.match(called('toast').at(-1)![0], /Repair.*Kimi Code/);
  }
});

test('a harness with no way to sign in here, or not listed, opens Settings → Other harnesses', () => {
  fx.state.basicHarnesses = [harness()];
  authRecovery(CHAT, SIGNED_OUT)!.signIn();
  fx.state.basicHarnesses = [];
  const r = authRecovery(CHAT, SIGNED_OUT)!;
  assert.equal(r.label, 'Sign in');
  r.signIn();
  assert.deepEqual(called('navigate'), [
    [{ name: 'settings', section: 'other-harnesses' }],
    [{ name: 'settings', section: 'other-harnesses' }],
  ]);
  assert.deepEqual(called('openPaneTab'), []);
});

test("a chat's sign-in over ACP shows as waiting, with Cancel, while main's sign-in for the harness waits", async () => {
  fx.state.basicHarnesses = [harness({ authMethods: [{ id: 'oauth', name: 'Browser' }] })];
  const cancels: string[] = [];
  fx.native.acp.cancelSignIn = async (id: string) => (cancels.push(id), true);
  const r = authRecovery(CHAT, SIGNED_OUT)!;
  assert.equal(r.waiting!.text({ basicSignIns: {} } as any), null);
  assert.equal(r.waiting!.text({ basicSignIns: { kimi: 'oauth' } } as any), 'Waiting for sign-in in the browser…');
  // another harness's sign-in is not this chat's
  assert.equal(r.waiting!.text({ basicSignIns: { qwen: 'oauth' } } as any), null);
  r.waiting!.cancel();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(cancels, ['kimi']);
});

test("a setup the harness's quirks name (dsh's key) offers Set up, which opens its Settings row, then Re-check", async () => {
  const how = 'Add a DeepSeek API key: put DEEPSEEK_API_KEY=<your key> in ~/.dsh/.env and Re-check';
  const dsh = (o: any = {}) => harness({ id: 'dsh', label: 'dsh', bin: '/bin/dsh', reason: how, ...o });
  fx.state.basicHarnesses = [dsh()];
  const r = authRecovery('acp:dsh:n1', `dsh: ${how}`)!;
  assert.equal(r.label, 'Set up');
  r.signIn();
  assert.deepEqual(called('navigate'), [[{ name: 'settings', section: 'other-harnesses' }]]);
  r.recheck?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(recheckCalls, ['dsh']);
  // only while it reads signed out with those words: other words, one set up since, or one not listed are not a setup
  assert.equal(authRecovery('acp:dsh:n1', 'dsh: something else'), null);
  assert.equal(authRecovery('acp:dsh:n1', how), null, 'the label comes first, as main says it');
  fx.state.basicHarnesses = [dsh({ state: 'admitted' })];
  assert.equal(authRecovery('acp:dsh:n1', `dsh: ${how}`), null);
  fx.state.basicHarnesses = [dsh({ reason: null })];
  assert.equal(authRecovery('acp:dsh:n1', 'dsh: null'), null);
  fx.state.basicHarnesses = [];
  assert.equal(authRecovery('acp:dsh:n1', `dsh: ${how}`), null);
  // a plain sign-in failure still reads Sign in, even when its reason is the default words
  fx.state.basicHarnesses = [dsh({ reason: 'Sign in to dsh first' })];
  assert.equal(authRecovery('acp:dsh:n1', 'dsh: Sign in to dsh first')!.label, 'Sign in');
});
