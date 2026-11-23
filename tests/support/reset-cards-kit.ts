// Reset-card UI test boundaries and fixtures shared by lifecycle and redemption tests.
import { afterEach, mock } from 'node:test';
import { window } from './dom.ts';
import { act, createElement } from 'react';
import assert from 'node:assert/strict';
import { installNativeStub } from './ports/native.ts';
const { createRoot } = await import('react-dom/client');
const f = () => (globalThis as any).__resetCards;
const boundary = {
  useStore: (s: any) => s(f().state),
  getState: () => f().state,
  setState: (p: any) => {
    Object.assign(f().state, p);
    f().updates.push(p);
  },
  toast: (...args: any[]) => f().toasts.push(args),
  useHarnessAccounts: (h: string) => ({ active: f()[h] }),
  accountName: (a: any) => a.email ?? a.id,
  refreshClaudeUsage: (reason: string) => {
    f().claudeReasons.push(reason);
    return f().refreshClaude(reason);
  },
  native: {
    accounts: { resetCredits: (id: string) => f().read(id), consumeResetCredit: (...args: any[]) => f().consume(...args) },
  },
  // the links go through the open helpers, which report a failure (tests/open.test.ts)
  openLink: (url: string) => f().opened.push(url),
  Group: (p: any) => createElement('section', null, p.title, p.desc, p.children),
  Row: (p: any) => createElement('article', null, p.title, p.desc, p.children),
  Segmented: (p: any) =>
    createElement(
      'nav',
      null,
      ...p.options.map((o: any) => createElement('button', { key: o.value, onClick: () => p.onChange(o.value) }, o.label)),
    ),
};
// the bridge the modules read, installed in the native port (src/lib/native.ts)
installNativeStub(boundary.native as object);
for (const rel of [
  'session/open.ts',
  'session/harness/claude.ts',
  'session/harness/select.ts',
  'harness/accounts.ts',
  'components/pages/Settings.tsx',
]) {
  mock.module(new URL(`../../src/${rel}`, import.meta.url).href, { namedExports: boundary });
}
// the cards import the store from the slice that owns it, under its own names there
mock.module(new URL('../../src/store/core.ts', import.meta.url).href, {
  namedExports: { ...boundary, get: boundary.getState, set: boundary.setState },
});
export const { CodexResetCards, ClaudeResetCards } = await import('../../src/components/harness/ResetCards.tsx');
export const card = (patch = {}) => ({
  id: 'card',
  title: 'Weekly reset',
  description: 'Restore the weekly limit',
  status: 'available',
  resetType: 'codexRateLimits',
  expiresAt: 4e9,
  ...patch,
});
export const reply = (cards: any[] | null = [card()], count: any = 1) => ({
  rateLimitResetCredits: { credits: cards, availableCount: count },
  rateLimits: { primary: { usedPercent: 5 } },
});
export function fixture(patch: any = {}) {
  const f: any = {
    codex: { id: 'a', email: 'a@test', kind: 'subscription' },
    claude: { id: 'c', email: 'c@test' },
    state: { accounts: { active: 'a', accounts: [{ id: 'a', status: 'ok' }] } },
    toasts: [],
    updates: [],
    opened: [],
    reads: [],
    consumes: [],
    confirmations: [],
    confirmed: true,
    read: async (id: string) => {
      f.reads.push(id);
      return f.reply;
    },
    consume: async (...args: any[]) => {
      f.consumes.push(args);
      return { outcome: f.outcome };
    },
    refreshClaude: async () => {
      f.claudeReads++;
    },
    claudeReads: 0,
    claudeReasons: [],
    reply: reply(),
    outcome: 'reset',
    ...patch,
  };
  (globalThis as any).__resetCards = f;
  (globalThis as any).confirm = (message: string) => {
    f.confirmations.push(message);
    return f.confirmed;
  };
  return f;
}
export let root: ReturnType<typeof createRoot> | null = null;
export let host: HTMLDivElement;
export async function mount(Component: any = CodexResetCards) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(Component)));
  return host;
}
export async function unmount() {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
    host.remove();
  }
}
export async function click(label: string) {
  const b = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
  assert.ok(b, `missing ${label}: ${host.textContent}`);
  await act(async () => b.click());
}
export async function focus() {
  await act(async () => window.dispatchEvent(new window.Event('focus')));
}
export async function expanded(value: boolean, Component: any = CodexResetCards) {
  await act(async () => root!.render(createElement(Component, { expanded: value })));
}
afterEach(async () => {
  await unmount();
});
