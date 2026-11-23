// Shared isolated native-plugin catalog fixture and UI state.
import { mock } from 'node:test';
import assert from 'node:assert/strict';
import './dom.ts';
import { mount, click, change, flush, settingsStubs, fakeStore, byText, popoverStubs, iconStubs } from './harness-ui-kit.ts';
import { installNativeStub } from './ports/native.ts';
import { stubStore } from './stubs.ts';

const { createElement: h, act } = await import('react');
const calls: any[] = [];
const rec =
  (name: string, ret?: any) =>
  (...a: any[]) => (calls.push([name, ...a]), ret);
const store = fakeStore<any>({ harness: 'codex' });
const handlers: Record<string, (p: any) => any> = {};
let dark = false;
stubStore({
  useStore: store.useStore,
  newChatHarness: (s: any) => s.harness,
  navigate: rec('navigate'),
  toast: rec('toast'),
  toastFailure: (what: string) => (e: any) => calls.push(['toast', `${what}: ${e?.message ?? e}`, 'error']),
});
mock.module('../../src/session/open.ts', { namedExports: { openLink: rec('open') } });
mock.module('../../src/harness/adapters/codex.ts', {
  namedExports: {
    codexRequest: async (m: string, p?: any) => {
      calls.push([m, p]);
      if (!handlers[m]) throw new Error(`unexpected ${m}`);
      return handlers[m](p);
    },
  },
});
mock.module('../../src/components/harness/codex/SkillsCatalog.tsx', { namedExports: { SkillsCatalog: () => h('div', { id: 'skills' }) } });
mock.module('../../src/components/pages/Login.tsx', { namedExports: { CodexNotice: ({ what }: any) => h('div', { id: 'notice' }, what) } });
mock.module('../../src/components/pages/Settings.tsx', { namedExports: { Segmented: settingsStubs.Segmented, Toggle: () => null } });
mock.module('../../src/components/skills/AllSkills.tsx', { namedExports: { AllSkills: () => h('div', { id: 'all-skills' }) } });
mock.module('../../src/components/plugins/StorePage.tsx', { namedExports: { StorePage: () => h('div', { id: 'store' }) } });
mock.module('../../src/components/plugins/PluginDetail.tsx', {
  namedExports: { PluginDetail: ({ id }: any) => h('div', { id: 'store-plugin' }, id) },
});
let storePlugins: any[] = [];
const setStorePlugins = (list: any[]) => (storePlugins = list);
mock.module('../../src/components/harness/parts.tsx', {
  namedExports: { PARTS: { codex: {}, claude: { Customize: ({ tab }: any) => h('div', { id: 'claude-custom' }, tab) } } },
});
mock.module('../../src/components/ui/icons.tsx', {
  namedExports: {
    ...iconStubs(),
    Blocks: () => h('span', { className: 'blocks' }),
    Spinner: () => h('span', { className: 'spin' }),
    ChevronRight: () => h('span', { className: 'chev' }),
    Info: () => h('span', { className: 'info' }),
  },
});
mock.module('../../src/components/ui/Popover.tsx', { namedExports: popoverStubs });
installNativeStub({
  clipboard: { write: (t: string) => (calls.push(['copy', t]), Promise.resolve()) },
  plugins: {
    list: async () => ({ plugins: storePlugins, error: null }),
    catalog: async () => ({ marketplaces: [], error: null }),
    native: async () => [],
    codexStates: async () => ({}),
    onChanged: () => () => undefined,
  },
});
mock.module('../../src/components/markdown/Markdown.tsx', { namedExports: { useResolvedDark: () => dark } });
const P = await import('../../src/components/harness/codex/Plugins.tsx');
/** The Plugins page on its Codex tab (it opens on every harness's store). */
async function mountCodexTab() {
  const r = await mount(h(P.Plugins, {}));
  await click(r.host.querySelector('[data-seg=codex]'));
  return r;
}
const { usePlugins } = P;

const setPlugins = (s: any) => act(async () => usePlugins.setState(s));
const reset = async () => {
  calls.length = 0;
  for (const k of Object.keys(handlers)) delete handlers[k];
  await setPlugins({ plugins: null, featured: [], loading: false, error: null });
};
const pl = (name: string, more: any = {}) => ({
  id: `${name}@openai-curated`,
  name,
  installed: false,
  marketplace: 'openai-curated',
  ...more,
});
const sent = () => calls.filter((c) => typeof c[0] === 'string' && c[0].includes('/')).map((c) => c[0]);
const titles = (host: HTMLElement) => [...host.querySelectorAll('.plugin-section-title')].map((t) => t.textContent!.trim());
const sectionNames = (host: HTMLElement, title: string) =>
  [
    ...([...host.querySelectorAll('.plugin-section')]
      .find((s) => s.querySelector('.plugin-section-title')!.textContent!.trim() === title)
      ?.querySelectorAll('.plugin-name') ?? []),
  ].map((n) => n.textContent);

const setDark = (value: boolean) => {
  dark = value;
};
export {
  setStorePlugins,
  assert,
  mount,
  click,
  change,
  flush,
  byText,
  h,
  act,
  calls,
  handlers,
  store,
  P,
  setPlugins,
  reset,
  pl,
  sent,
  titles,
  sectionNames,
  mountCodexTab,
  setDark,
};
