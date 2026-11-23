// Shared native-boundary fixture for ACP catalog and individual harness settings tests.
import { mock } from 'node:test';
import './dom.ts';
import { fakeStore, settingsExports, versionRowExports, render, click, byText, maybeText } from './pages-kit.ts';
import { defaultHarnessExports } from './default-harness-fakes.ts';
import { stubStore } from './stubs.ts';
import { admissionFailure } from '../../src/harness/copy';

const { createElement: h, act } = await import('react');
export const ctl = {
  loginFor: {} as Record<string, any>,
  exitTerm: null as (() => void) | null,
  fresh: 0,
  toolsAsked: 0,
  versionChecks: 0,
  /** harness kinds main has an update for (useHarnessUpdate) */
  updates: new Set<string>(),
};
const calls: any[] = [];
const store = fakeStore<any>({ basicHarnesses: [], basicSignIns: {}, prefs: {}, home: '/home/ada' });
const setPrefs = (p: any) => (calls.push(['prefs', p]), store.setState({ prefs: { ...store.getState().prefs, ...p } }));
const infos: Record<string, any> = {};

stubStore({
  useStore: store.useStore,
  getState: store.getState,
  setPrefs,
  toast: (...args: any[]) => calls.push(['toast', ...args]),
  ...defaultHarnessExports(store.getState, setPrefs),
});
mock.module('../../src/session/harness/acp.ts', {
  namedExports: {
    TURNED_OFF: (r: string | null) => r ?? 'Turned off for now',
    UNSUPPORTED: admissionFailure,
    SIGNIN_WAITING: 'Waiting for sign-in in the browser…',
    authenticateBasic: (b: any, m: string) => calls.push(['auth', b.id, m]),
    cancelBasicSignIn: (id: string) => calls.push(['cancelSignIn', id]),
    loginCommand: (b: any, m: string | null) => ctl.loginFor[`${b.id}:${m}`] ?? null,
    recheckBasic: (id: string) => calls.push(['recheck', id]),
    useFreshBasics: () => (ctl.fresh += 1),
  },
});
mock.module('../../src/components/panels/TerminalPanel.tsx', {
  namedExports: {
    TermView: ({ tab, onExit }: any) => (
      (ctl.exitTerm = onExit),
      h(
        'div',
        { 'data-term': tab.id, 'data-cwd': tab.cwd, 'data-title': tab.title, 'data-sign-in': String(!!tab.signIn) },
        tab.command.join(' '),
      )
    ),
  },
});
mock.module('../../src/harness/registry.ts', { namedExports: { harnessInfo: (k: string) => infos[k] ?? null } });
mock.module('../../src/session/harness/harnessRuns.ts', {
  namedExports: {
    refreshInstallTools: () => {
      ctl.toolsAsked += 1;
    },
  },
});
// the lines themselves are InstallLines' (tests/installLines.test.ts): here, which harness they are for
mock.module('../../src/components/harness/InstallLines.tsx', {
  namedExports: {
    InstallLines: ({ item, onSetLocation }: any) =>
      h('div', { 'data-install-lines': item.kind }, h('button', { onClick: onSetLocation }, 'Locate')),
  },
});
// the versions are read again when the page opens (src/harness/harnessUpdates.ts is tested on its own)
mock.module('../../src/harness/harnessUpdates.ts', { namedExports: { checkHarnessUpdates: async () => void (ctl.versionChecks += 1) } });
// the version line's own behavior is in tests/harnessVersionLine.test.ts: here, that it sits in Version in use
mock.module('../../src/components/harness/HarnessVersionLine.tsx', {
  namedExports: {
    HarnessVersionLine: ({ kind, label, version }: any) =>
      h('i', { 'data-version-of': kind, 'data-label': label, 'data-version': String(version) }),
  },
});
// the update pill's own behavior is in tests/harnessUpdate.test.ts: here, that a harness needing an update offers it
mock.module('../../src/components/harness/HarnessUpdate.tsx', {
  namedExports: {
    useHarnessUpdate: (kind: string) => (ctl.updates.has(kind) ? { kind } : null),
    UpdatePill: ({ u }: any) => h('b', { 'data-update-pill': u.kind }),
  },
});
mock.module('../../src/session/open.ts', { namedExports: { openLink: (u: string) => calls.push(['open', u]) } });
mock.module('../../src/components/harnessPicker/HarnessPicker.tsx', {
  namedExports: {
    BasicBadge: ({ id }: any) => h('em', { 'data-badge': id }),
    BasicHarnessIcon: ({ id }: any) => h('i', { 'data-icon': id }),
  },
});
// the version row itself is tests/harnessVersionRow.test.ts': here, what an installed harness hands it
mock.module('../../src/components/harness/HarnessVersionRow.tsx', { namedExports: versionRowExports });
mock.module('../../src/components/pages/Settings.tsx', { namedExports: settingsExports });
// the route notice and the tab strip are the harness pages' own (tests/harnessPages.test.ts): here, stand-ins
mock.module('../../src/components/harness/RouteNotice.tsx', {
  namedExports: { RouteNotice: ({ harness }: any) => h('div', { 'data-route': harness }) },
});
mock.module('../../src/components/pages/settings/HarnessPage.tsx', {
  namedExports: {
    HarnessTabs: ({ value, onChange }: any) =>
      h(
        'div',
        { 'data-tabs': value },
        ['overview', 'extensions', 'advanced'].map((t) => h('button', { key: t, 'data-tab': t, onClick: () => onChange(t) }, t)),
      ),
  },
});
// the New chats use row itself is tests/allHarnesses.test.ts': here, which pages have it
mock.module('../../src/components/harness/AllHarnesses.tsx', {
  namedExports: { NewChatsUseRow: ({ own }: any) => h('div', { 'data-row': 'New chats use', 'data-own': own }) },
});
// the checklist itself is WhatWorks' (tests/whatWorks.test.ts): here, which harness it is for and where
mock.module('../../src/components/harness/WhatWorks.tsx', {
  namedExports: {
    WhatWorks: ({ kind, label, inline }: any) => h('div', { 'data-works': kind, 'data-label': label, 'data-inline': String(!!inline) }),
  },
});
// the user's own MCP servers have their own tests (tests/ownMcpUI.test.ts): here, which harness's rows sit where
mock.module('../../src/components/harness/OwnMcp.tsx', {
  namedExports: { OwnMcpSettings: ({ harness }: any) => h('div', { 'data-own-mcp': harness }) },
});
// Registry browsing has its own real-component tests; this fixture owns the surrounding catalog layout.
mock.module('../../src/components/harness/RegistryAgents.tsx', {
  namedExports: { RegistryAgents: () => h('div', { 'data-registry-browser': true }) },
});
const { OtherHarnesses } = await import('../../src/components/pages/settings/OtherHarnesses.tsx');

const harness = (over: any) => ({
  id: 'x',
  label: 'X',
  state: 'admitted',
  reason: null,
  authMethods: [],
  login: false,
  bin: null,
  version: null,
  ...over,
});
const status = (host: HTMLElement, id: string) => host.querySelector(`[data-harness-status=${id}]`)!.textContent;
const rowOf = (host: HTMLElement, id: string) => host.querySelector(`.basic-row[data-harness=${id}]`) as HTMLElement;
const ids = (root: ParentNode) => [...root.querySelectorAll('[data-icon]')].map((e) => e.getAttribute('data-icon'));
const section = (host: HTMLElement, title: string) =>
  [...host.querySelectorAll('section')].find((x) => x.querySelector('h3')?.textContent === title) as HTMLElement;
/** Open an installed harness's details. */
const open = (host: HTMLElement, id: string) => click(rowOf(host, id).querySelector('[aria-expanded]'));

export { calls, store, infos, OtherHarnesses, harness, status, rowOf, ids, section, open, h, act, render, click, byText, maybeText };
