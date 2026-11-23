// The fixture of Computer History's Settings UI tests (#1363): main's computerHistory API as an in-memory fake, the store and Settings controls mocked, and a mount helper; imported before the components so the mocks apply.
import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './dom.ts';
import { installNativeStub } from './ports/native.ts';
import { stubStore } from './stubs.ts';

const React = await import('react');
export const { act, createElement } = React;
const { createRoot } = await import('react-dom/client');

export const base = () => ({
  status: 'off',
  settings: { enabled: false, paused: false, apps: [], sites: [], retentionDays: 30, explainerSeen: false },
  suspended: [],
  error: null,
  settingsError: null,
});
export const f: any = { calls: [], toasts: [], nav: [], listeners: new Set() };
/** main's computerHistory:changed, to every window listener */
f.broadcast = (s: unknown) => {
  for (const cb of [...f.listeners]) cb(s);
};
const answer = () => ({ ok: true, state: f.state });
const refuse = (reason: string) => ({ ok: false, reason });
f.native = {
  computerHistory: {
    state: () => (f.calls.push(['state']), f.stateAnswer()),
    setEnabled: async (v: boolean) => {
      f.calls.push(['setEnabled', v]);
      f.state = { ...f.state, status: v ? 'recording' : 'off', settings: { ...f.state.settings, enabled: v, paused: false } };
      return answer();
    },
    pause: async () => (f.calls.push(['pause']), (f.state = { ...f.state, status: 'paused' }), answer()),
    resume: async () => (f.calls.push(['resume']), (f.state = { ...f.state, status: 'recording' }), answer()),
    explainerSeen: async () => (
      f.calls.push(['explainerSeen']), (f.state = { ...f.state, settings: { ...f.state.settings, explainerSeen: true } }), answer()
    ),
    allowApp: async (app: any) => {
      f.calls.push(['allowApp', app.bundleId]);
      if (f.refuseNext) return refuse(f.refuseNext);
      f.state = { ...f.state, settings: { ...f.state.settings, apps: [...f.state.settings.apps, app] } };
      return answer();
    },
    removeApp: async (id: string) => (
      f.calls.push(['removeApp', id]),
      (f.state = { ...f.state, settings: { ...f.state.settings, apps: f.state.settings.apps.filter((a: any) => a.bundleId !== id) } }),
      answer()
    ),
    allowSite: async (site: string) => {
      f.calls.push(['allowSite', site]);
      if (f.throwNext) throw new Error(f.throwNext);
      if (f.refuseNext) return refuse(f.refuseNext);
      f.state = { ...f.state, settings: { ...f.state.settings, sites: [...f.state.settings.sites, site.trim()] } };
      return { ...answer(), site };
    },
    removeSite: async (site: string) => (
      f.calls.push(['removeSite', site]),
      (f.state = { ...f.state, settings: { ...f.state.settings, sites: f.state.settings.sites.filter((s: string) => s !== site) } }),
      answer()
    ),
    setRetention: async (d: number) => (
      f.calls.push(['setRetention', d]), (f.state = { ...f.state, settings: { ...f.state.settings, retentionDays: d } }), answer()
    ),
    days: async () => (f.calls.push(['days']), f.daysAnswer()),
    memories: async (q: any) => (f.calls.push(['memories', q]), f.memoriesAnswer(q)),
    deleteDay: async (day: string) => (f.calls.push(['deleteDay', day]), (f.days = f.days.filter((d: string) => d !== day)), answer()),
    deleteAll: async () => (f.calls.push(['deleteAll']), (f.days = []), answer()),
    candidates: async () => (f.calls.push(['candidates']), f.candidatesAnswer()),
    onChanged: (cb: any) => {
      f.listeners.add(cb);
      return () => f.listeners.delete(cb);
    },
  },
  computer: { openSettings: async (k: string) => (f.calls.push(['openSettings', k]), f.opened) },
};
installNativeStub(f.native);
stubStore({
  toast: (text: string, kind: string) => f.toasts.push([text, kind]),
  toastFailure: (what: string) => (e: unknown) => f.toasts.push([`${what}: ${String(e)}`, 'error']),
  navigate: (r: unknown) => f.nav.push(r),
});
mock.module('../../src/components/pages/Settings.tsx', {
  namedExports: {
    Group: ({ title, desc, action, children }: any) =>
      createElement('section', { 'data-group': title, 'data-desc': desc }, action, children),
    Row: ({ title, desc, children }: any) =>
      createElement('div', { className: 'row', 'data-title': title, 'data-desc': desc ?? '' }, children),
    Toggle: ({ on, onChange }: any) =>
      createElement('input', { type: 'checkbox', className: 'toggle', checked: on, onChange: () => onChange(!on) }),
    Select: ({ value, options, onChange }: any) =>
      createElement(
        'select',
        { className: 'retention', value, onChange: (e: any) => onChange(e.target.value) },
        options.map((o: any) => createElement('option', { key: o.value, value: o.value }, o.label)),
      ),
  },
});
export const { ComputerHistorySettings, NEVER_SITES } = await import('../../src/components/pages/settings/ComputerHistory.tsx');
export const { CAPTURED, NEVER } = await import('../../src/components/pages/settings/ComputerHistoryExplainer.tsx');
export const { SidebarHistory } = await import('../../src/components/sidebar/SidebarHistory.tsx');
export const { dayLabel, refusalOf, STATUS_LABEL, statusDetail } = await import('../../src/store/computerHistory.ts');

/** The latest call that changes something (re-reads of the days and the state follow every change). */
export const lastOf = () => f.calls.filter(([c]: string[]) => c !== 'days' && c !== 'state').at(-1);
export const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
export const on = (over: any = {}) => ({
  ...base(),
  status: 'recording',
  settings: {
    ...base().settings,
    enabled: true,
    explainerSeen: true,
    apps: [{ bundleId: 'com.apple.Notes', name: 'Notes' }],
    sites: ['example.com'],
  },
  ...over,
});
export function reset(state: any = base()) {
  f.calls = [];
  f.toasts = [];
  f.nav = [];
  f.state = state;
  f.days = ['2026-10-18', '2026-10-17'];
  f.opened = true;
  f.refuseNext = null;
  f.throwNext = null;
  f.stateAnswer = async () => ({
    ok: true,
    state: f.state,
    exclusions: {
      apps: [
        { pattern: 'com.1password.*', reason: 'password manager' },
        { pattern: 'ai.mopilot.code.*', reason: 'MoPilot' },
      ],
      healthSites: ['mychart.com'],
    },
  });
  f.daysAnswer = async () => ({ ok: true, state: f.state, days: f.days });
  f.memoriesAnswer = async (q: any) => ({
    ok: true,
    state: f.state,
    text: `## ${q.days[0]}\n- 14:02–14:27 · Notes · "Plan" · 25 min`,
    memories: [],
    block: null,
    unreadable: 0,
  });
  f.candidatesAnswer = async () => ({
    ok: true,
    apps: [
      { bundleId: 'com.apple.Notes', name: 'Notes', excluded: null },
      { bundleId: 'com.apple.TextEdit', name: 'TextEdit', excluded: null },
      { bundleId: 'com.1password.1password', name: '1Password', excluded: 'password manager' },
    ],
  });
  (window as any).confirm = () => true;
}
export async function mount(component: any = ComputerHistorySettings) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(component)));
  await flush();
  const all = (sel: string) => [...host.querySelectorAll(sel)] as any[];
  return {
    host,
    q: (sel: string) => host.querySelector(sel) as any,
    rows: () => all('.row').map((r) => r.getAttribute('data-title')),
    row: (title: string) => all('.row').find((r) => r.getAttribute('data-title') === title),
    button: (text: string, scope: any = host) =>
      [...scope.querySelectorAll('button')].find((b: any) => b.textContent.trim() === text) as any,
    click: async (el: any) => {
      assert.ok(el, 'element to click');
      await act(async () => el.click());
      await flush();
    },
    pick: async (el: any, value: string) => {
      await act(async () => {
        el.value = value;
        el.dispatchEvent(new window.Event('change', { bubbles: true }));
      });
      await flush();
    },
    close: async () => {
      await act(() => root.unmount());
      host.remove();
    },
  };
}
