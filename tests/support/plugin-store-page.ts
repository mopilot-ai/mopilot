// What the shared Plugins page's tests share: window.native.plugins as a fake with made-up data, stubs and finders.
import { mock, beforeEach } from 'node:test';
import './dom.ts';
import { createElement as h } from 'react';
import { mount, click, change, flush, settingsStubs, iconStubs, byText } from './harness-ui-kit.ts';

export { mount, click, change, flush, byText, h };
import { installNativeStub } from './ports/native.ts';
import { stubStore } from './stubs.ts';

export const calls: unknown[][] = [];
export const toasts: unknown[][] = [];
export let changed: (() => void) | null = null;
export let fake: Record<string, (...a: any[]) => any> = {};

// what each switch's change returned: the real Toggle stays pending until it settles
export const toggleRuns: unknown[] = [];
mock.module('../../src/components/pages/Settings.tsx', {
  namedExports: {
    Group: settingsStubs.Group,
    Row: settingsStubs.Row,
    Segmented: settingsStubs.Segmented,
    Toggle: ({ on, onChange, disabled, label }: any) =>
      h('button', { role: 'switch', 'aria-checked': on, 'aria-label': label, disabled, onClick: () => toggleRuns.push(onChange(!on)) }),
  },
});
mock.module('../../src/components/ui/icons.tsx', {
  namedExports: {
    ...iconStubs(),
    Blocks: () => h('i', { className: 'blocks' }),
    Server: () => h('i', { className: 'server' }),
    Sparkles: () => h('i', { className: 'sparkles' }),
  },
});
export const routes: unknown[] = [];
stubStore({ toast: (...a: unknown[]) => void toasts.push(a), navigate: (r: unknown) => void routes.push(r) });
let codexOn = true;
export const setCodexOn = (on: boolean) => (codexOn = on);
mock.module('../../src/lib/flags.ts', { namedExports: { useFlag: () => codexOn } });
installNativeStub({
  plugins: new Proxy(
    {},
    {
      get: (_t, name: string) =>
        name === 'onChanged'
          ? (cb: () => void) => ((changed = cb), () => (changed = null))
          : (...a: unknown[]) => (calls.push([name, ...a]), fake[name](...a)),
    },
  ),
});

export const { StorePage, DISCOVER_LIMIT } = await import('../../src/components/plugins/StorePage.tsx');
export const { reachLine } = await import('../../src/components/plugins/ReachStrip.tsx');
export const { reachException } = await import('../../src/components/plugins/ReachStrip.tsx');
export const { TrustDialog, commandsOf } = await import('../../src/components/plugins/TrustDialog.tsx');
export const { PluginDetail } = await import('../../src/components/plugins/PluginDetail.tsx');
export const { AddMarketplaceDialog } = await import('../../src/components/plugins/AddMarketplaceDialog.tsx');
export const { ConfirmDialog } = await import('../../src/components/plugins/ConfirmDialog.tsx');
export const { PluginTile, titleOfName, pluginTitle } = await import('../../src/components/plugins/pluginView.tsx');

export const spec = (name: string, o: Record<string, unknown> = {}) => ({
  name,
  displayName: name,
  description: `${name} things`,
  layout: '.claude-plugin/plugin.json',
  root: `/store/${name}`,
  skills: [{ name: 's', file: '/s' }],
  commands: [],
  agents: [],
  hooks: [],
  mcpServers: {},
  apps: [],
  problems: [],
  ...o,
});
export const plugin = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  path: `/store/${id}`,
  enabled: true,
  harnesses: {},
  trusted: 't',
  installedAt: 1,
  updatedAt: 1,
  spec: spec(id.split('@')[0]),
  error: null,
  ...o,
});
export const ready = (name: string, runs: string[] = []) => ({ ok: true, spec: spec(name), runs, trust: `trust-${name}` });

beforeEach(() => {
  calls.length = 0;
  toasts.length = 0;
  routes.length = 0;
  fake = {
    list: async () => ({
      plugins: [
        plugin('tidy@acme', { spec: spec('tidy', { apps: ['gmail'] }) }),
        plugin('off@acme', { enabled: false }),
        plugin('broken@acme', { spec: null, error: 'gone' }),
      ],
      error: null,
    }),
    catalog: async () => ({
      marketplaces: [
        {
          name: 'acme',
          source: { kind: 'git', url: 'https://x/acme.git', ref: 'v1' },
          marketplace: {
            name: 'acme',
            plugins: [
              { name: 'tidy', source: { kind: 'path', path: 'tidy' } },
              { name: 'notes', description: 'Take notes', source: { kind: 'path', path: 'notes' } },
              { name: 'other', source: { kind: 'path', path: 'other' } },
            ],
            problems: [],
          },
          error: null,
        },
        { name: 'local', source: { kind: 'local', path: '/mkt' }, marketplace: null, error: 'No marketplace.json' },
        {
          name: 'mine',
          source: { kind: 'local', path: '/Users/me/mkt' },
          marketplace: { name: 'mine', plugins: [], problems: [] },
          error: null,
        },
        {
          name: 'plain',
          source: { kind: 'git', url: 'https://x/plain.git' },
          marketplace: null,
          error: null,
        },
      ],
      error: null,
    }),
    native: async () => [
      { id: 'tidy@acme', name: 'tidy', marketplace: 'acme', path: '/c/tidy', harness: 'claude' },
      { id: 'gmail@curated', name: 'gmail', marketplace: 'curated', path: '/x/gmail', harness: 'codex' },
    ],
    codexStates: async () => ({ 'tidy@acme': { codexId: 'tidy@mopilot-acme', path: '/p', state: 'failed', error: 'refused' } }),
    preview: async (_m: string, name: string) => ready(name, ['mcp srv: node ${PLUGIN_ROOT}/s.js']),
    install: async () => ({ id: 'x' }),
    previewNative: async () => ready('gmail'),
    importNative: async () => ({ id: 'gmail@curated' }),
    setEnabled: async () => ({}),
    uninstall: async () => true,
    marketplaceAdd: async (s: string) => `added-${s}`,
    marketplaceUpgrade: async () => true,
    marketplaceRemove: async () => true,
  };
});

export const rowOf = (host: HTMLElement, title: string) => byText(host, '.row > b', title)!.parentElement as HTMLElement;
export const cardOf = (host: HTMLElement, title: string) =>
  byText(host, '.plugin-card-name', title)!.closest('.plugin-card') as HTMLElement;
export const seg = (host: HTMLElement, view: string) => click(host.querySelector(`[data-seg=${view}]`));
export const dialogOf = (host: HTMLElement) => host.querySelector('[role=dialog]') as HTMLElement;
export const key = async (k: string) =>
  (await import('react')).act(async () => window.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: k })));
export const press = async (el: Element) =>
  (await import('react')).act(async () => el.dispatchEvent(new (window as any).MouseEvent('mousedown', { bubbles: true })));
export const button = (el: ParentNode, label: string | RegExp) => byText(el, 'button', label);
