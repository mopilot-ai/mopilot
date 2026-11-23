// A side chat's tab in the title bar (src/components/titleBar/SideChatTitle.tsx): it names the account the side chat runs
// on as every surface does (design/multi-account rule 1), for either first-tier harness.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { stubStore } from './support/stubs.ts';

const fixture = {
  family: {} as Record<string, string | null>,
  own: {} as Record<string, any>,
  accounts: {} as Record<string, any>,
};
stubStore({ useStore: (select: (s: any) => any) => select({}) });
const labels = await import('../src/harness/chatAccountLabel.ts');
mock.module('../src/session/harness/select.ts', {
  namedExports: {
    chatAccountLabel: labels.chatAccountLabel,
    useComposerFirstTier: (id: string | null) => (id ? (fixture.family[id] ?? null) : 'codex'),
    useChatAccount: (h: string, id: string | null) => (id ? (fixture.own[`${h}:${id}`] ?? null) : null),
    useHarnessAccounts: (h: string) => fixture.accounts[h] ?? { active: null, accounts: [] },
  },
});
const { SideChatTitle } = await import('../src/components/titleBar/SideChatTitle.tsx');
const html = (threadId: string | null | undefined) => renderToStaticMarkup(createElement(SideChatTitle, { threadId }));

test('a side chat tab names its account in its tooltip, "Pinned to B · now on A" while they differ', () => {
  fixture.family = { cx: 'codex', cl: 'claude', basic: null };
  fixture.accounts = {
    codex: { active: null, accounts: [{ id: 'a', email: 'a@x' }] },
    claude: {
      active: null,
      accounts: [
        { id: 'w', email: 'work@x' },
        { id: 'h', email: 'home@x' },
      ],
    },
  };
  fixture.own = { 'codex:cx': { id: 'a', pinned: true, serving: 'a' }, 'claude:cl': { id: 'w', pinned: true, serving: 'h' } };
  assert.equal(html('cx'), '<span title="Side chat · a@x">Side chat</span>');
  assert.equal(html('cl'), '<span title="Side chat · Pinned to work@x · now on home@x">Side chat</span>');
  // no account of its own, a basic harness, or no thread yet: just the name
  fixture.own = {};
  assert.equal(html('cx'), '<span>Side chat</span>');
  assert.equal(html('basic'), '<span>Side chat</span>');
  assert.equal(html(undefined), '<span>Side chat</span>');
});
