// Shared fixture for the Browser use settings UI tests (tests/browserUseSettingsUI.test.ts): app services stubbed as
// `f`, the real BrowserUseSettings component and Sites libraries, and a mounted page with helpers to read and edit it.
import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './dom.ts';
import { installNativeStub } from './ports/native.ts';
import { stubStore } from './stubs.ts';

const React = await import('react');
export const { act, createElement } = React;
const { createRoot } = await import('react-dom/client');

export const f: any = {
  calls: [],
  toast: (text: string, kind: string) => f.calls.push(['toast', text, kind]),
  useChromeLinks: (on: boolean) => (on ? f.links : null),
  Group: ({ title, desc, children }: any) => createElement('section', { 'data-group': title, 'data-desc': desc }, children),
  Row: ({ title, desc, children }: any) =>
    createElement('div', { className: 'row', 'data-title': title, 'data-desc': desc ?? '' }, children),
  Select: ({ value, options, onChange }: any) =>
    createElement(
      'select',
      { className: 'pref', value, onChange: (e: any) => onChange(e.target.value) },
      options.map((o: any) => createElement('option', { key: o.value, value: o.value }, o.label)),
    ),
  Toggle: ({ on, onChange, disabled }: any) =>
    createElement('input', { type: 'checkbox', className: 'toggle', checked: on, disabled: !!disabled, onChange: () => onChange(!on) }),
  native: {
    browserUse: {
      state: () => (f.calls.push(['state']), f.stateAnswer()),
      setPreference: (name: string, value: any) => (f.calls.push(['setPreference', name, value]), f.changeAnswer()),
      setRule: (resource: string, origin: string, decision: any) => (
        f.calls.push(['setRule', resource, origin, decision]), f.changeAnswer()
      ),
      forget: (origin: string) => (f.calls.push(['forget', origin]), f.changeAnswer()),
    },
    browser: {
      sites: (browser: string) => (f.calls.push(['sites', browser]), Promise.resolve(f.table(browser))),
      // each browser keeps its own table: the built-in browser's in f.grants, Your Chrome's in f.chromeGrants
      setSite: async (origin: string, level: any, browser: string) => {
        f.calls.push(['setSite', origin, level, browser]);
        if (f.setSiteFails) throw new Error('disk full');
        const list = f.table(browser);
        const next = level
          ? [...list.filter((g: any) => g.origin !== origin), { origin, level }]
          : list.filter((g: any) => g.origin !== origin);
        if (browser === 'chrome') f.chromeGrants = next;
        else f.grants = next;
        return next;
      },
      // Site permissions below the table (its own test: browserWebPermissionsSettingsUI.test.ts): never answered here
      webPermissions: () => new Promise(() => {}),
    },
  },
};
installNativeStub(f.native);
mock.module('../../src/session/open.ts', { namedExports: { openLink: (u: string) => f.calls.push(['openLink', u]) } });
mock.module('../../src/session/nativeAvailability.ts', { namedExports: { useChromeLinks: (on: boolean) => f.useChromeLinks(on) } });
stubStore({ toast: (text: string, kind: string) => f.toast(text, kind) });
mock.module('../../src/components/pages/Settings.tsx', {
  namedExports: {
    Group: (p: any) => f.Group(p),
    Row: (p: any) => f.Row(p),
    Select: (p: any) => f.Select(p),
    Toggle: (p: any) => f.Toggle(p),
  },
});
export const { BrowserUseSettings } = await import('../../src/components/pages/settings/BrowserUse.tsx');
export const { siteRows, policyRows, siteOrigin, addTarget, ADD_CHOICES, CLAUDE_CHROME_PERMISSIONS } = await import(
  '../../src/lib/browserSites.ts'
);

export const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
const ASK = { options: ['always_ask', 'never_ask'], locked: null };
export function view(over: any = {}) {
  return {
    file: 'browser/config.toml',
    disabled: null,
    requirementsKnown: true,
    prefs: {
      approvalMode: { value: 'always_ask', ...ASK },
      historyMode: { value: 'always_ask', options: ['always_ask', 'never_ask', 'disabled'], locked: null },
      downloadMode: { value: 'never_ask', ...ASK },
      uploadMode: { value: 'always_ask', ...ASK },
      fullCdp: { value: false, options: [true, false], locked: null },
    },
    sites: [{ origin: 'https://a.test', browse: 'allow', downloads: null, uploads: 'deny', debug: null }],
    policies: [],
    ...over,
  };
}
export function reset(state: any = view()) {
  f.calls = [];
  f.links = null;
  f.grants = [{ origin: 'https://b.test', level: 'read' }];
  f.chromeGrants = [];
  f.table = (browser: string) => (browser === 'chrome' ? f.chromeGrants : f.grants);
  f.setSiteFails = false;
  f.native.browser.sites = (browser: string) => (f.calls.push(['sites', browser]), Promise.resolve(f.table(browser)));
  f.stateAnswer = async () => state;
  f.changeAnswer = async () => state;
}
export async function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(BrowserUseSettings)));
  await flush();
  const q = (sel: string) => host.querySelector(sel) as any;
  return {
    host,
    q,
    rows: () => [...host.querySelectorAll('.row')].map((r: any) => [r.getAttribute('data-title'), r.getAttribute('data-desc')]),
    sites: () =>
      [...host.querySelectorAll('.sites-row:not(.sites-head)')].map((r: any) =>
        [...r.querySelectorAll('[role="cell"]')].map((c: any) =>
          c.querySelector('select') ? c.querySelector('select').value || 'ask' : c.textContent.trim(),
        ),
      ),
    button: (text: string) => [...host.querySelectorAll('button')].find((b: any) => b.textContent.trim() === text) as any,
    pick: async (el: any, value: string) => {
      await act(async () => {
        el.value = value;
        el.dispatchEvent(new window.Event('change', { bubbles: true }));
      });
      await flush();
    },
    click: async (el: any) => {
      assert.ok(el);
      await act(async () => el.click());
      await flush();
    },
    close: async () => {
      await act(() => root.unmount());
      host.remove();
    },
  };
}

export { window };
