// Codex's lapsed-sign-in banner (src/components/harness/codex/ExpiredBanner.tsx): which login it names, what it offers,
// and that it shows only where Codex's login is in play, never in a Claude Code or basic harness's chat.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mount, click, byText, fakeStore } from './support/harness-ui-kit.ts';
import { iconStubs, mockSource, stubStore } from './support/stubs.ts';

const { createElement: h } = await import('react');
const calls: any[] = [];
const rec =
  (name: string) =>
  (...a: any[]) =>
    calls.push([name, ...a]);
const store = fakeStore<any>({ accounts: { accounts: [], active: null }, claudeChats: {}, route: { name: 'home' } });
stubStore({ useStore: store.useStore, switchAccount: rec('switchAccount'), addAccount: rec('addAccount') });
// the family the composer targets for a chat (null: what new chats start on)
let family: (id: string | null) => string = () => 'codex';
// Codex's account view is the account manager's pool, as harness/select.ts builds it
const { codexAccounts } = await import('../src/harness/accounts.ts');
mock.module('../src/session/harness/select.ts', {
  namedExports: {
    useHarnessStatus: () => ({ state: 'ready' }),
    useHarnessAccounts: () => {
      const s = store.useStore((st: any) => st);
      return codexAccounts({ accounts: s.accounts, account: null, rateLimits: null, requiresAuth: false });
    },
    useComposerFamily: (id: string | null) => family(id),
  },
});
mockSource('src/components/ui/icons.tsx', iconStubs());
const { CodexExpiredBanner } = await import('../src/components/harness/codex/ExpiredBanner.tsx');

const codex = (p: any) => ({ id: 'x', email: 'x@x.com', kind: 'chatgpt', status: 'ok', chats: 0, isDefault: false, ...p });
const accounts = (p: any) => store.set({ accounts: { ...store.get().accounts, ...p } });
/** The banner's text where it shows, or null. */
async function banner(route: any, families: Record<string, string> = {}, newChats = 'codex') {
  store.set({ route });
  family = (id) => (id ? families[id] : newChats);
  const r = await mount(h(CodexExpiredBanner));
  const t = r.host.querySelector('.acct-banner')?.textContent ?? null;
  await r.unmount();
  return t;
}

beforeEach(() => {
  calls.length = 0;
  family = () => 'codex';
  store.set({ accounts: { accounts: [], active: null }, route: { name: 'home' } });
});

test('names Codex and the login, and signs it in again', async () => {
  accounts({ active: 'a', accounts: [codex({ id: 'a', email: null, status: 'expired' })] });
  const r = await mount(h(CodexExpiredBanner));
  assert.match(r.host.textContent ?? '', /^Your Codex sign-in for this account has expired\./);
  assert.equal(r.host.querySelectorAll('button').length, 1);
  await click(byText(r.host, 'button', 'Sign in again'));
  assert.deepEqual(calls.at(-1), ['addAccount', 'a']);
  await r.unmount();
});

test('offers another healthy ChatGPT account when there is one, and stays away with no login in use', async () => {
  accounts({
    active: 'a',
    accounts: [
      codex({ id: 'a', email: 'a@x.com', status: 'expired' }),
      codex({ id: 'k', kind: 'apiKey', email: 'k@x.com' }),
      codex({ id: 'x2', email: 'x2@x.com', status: 'expired' }),
      codex({ id: 'l', email: 'l@x.com', limits: { reached: true } }),
      codex({ id: 'b', email: 'b@x.com', limits: { used: 10 } }),
    ],
  });
  let r = await mount(h(CodexExpiredBanner));
  assert.match(r.host.textContent ?? '', /a@x\.com/);
  await click(byText(r.host, 'button', 'Use b@x.com'));
  assert.deepEqual(calls.at(-1), ['switchAccount', 'b']);
  await r.unmount();
  // with no account in use, the first login having expired is not the one to warn about
  accounts({ active: null });
  r = await mount(h(CodexExpiredBanner));
  assert.equal(r.host.querySelector('.acct-banner'), null);
  await r.unmount();
});

test("shows only where Codex's login is in play, never in a Claude Code chat", async () => {
  accounts({ active: 'a', accounts: [codex({ id: 'a', email: 'a@x.com', status: 'expired' })] });
  const families = { c1: 'claude', x1: 'codex', 'acp:kimi:1': 'acp' };
  // the reported case: a Claude Code chat runs on no ChatGPT login, whatever new chats start on
  assert.equal(await banner({ name: 'thread', id: 'c1' }, families), null);
  assert.equal(await banner({ name: 'thread', id: 'acp:kimi:1' }, families), null);
  // outside a chat it is about the harness new chats start on
  assert.equal(await banner({ name: 'home' }, families, 'claude'), null);
  assert.match((await banner({ name: 'home' }, families))!, /^Your Codex sign-in for a@x\.com has expired\./);
  // a Codex chat warns whatever new chats start on
  assert.match((await banner({ name: 'thread', id: 'x1' }, families, 'claude'))!, /Codex sign-in for a@x\.com has expired/);
});
