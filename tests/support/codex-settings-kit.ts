// The Codex settings components rendered for real, with their app modules stubbed: the fixture the stubs read
// and write, and mount() with the clicks and reads the tests use. Shared by codexSettingsUI and codexMemoryUI.
import { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { transformWithOxc } from 'vite';
import { Window } from 'happy-dom';

export const window = new Window();
for (const name of ['window', 'document', 'Node', 'HTMLElement', 'Event'])
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : (window as any)[name] });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
export const fixture: any = {};
(globalThis as any).__rcFixture = fixture;
const url = new URL('../../src/components/harness/codex/settings.tsx', import.meta.url);
const sources = new Map<string, string>();
for (const name of ['settings', 'settingsImport', 'settingsConfig', 'settingsControls', 'settingsShared']) {
  const file = new URL(`../../src/components/harness/codex/${name}.tsx`, import.meta.url);
  const compiled = await transformWithOxc(readFileSync(file, 'utf8'), file.href, { jsx: { runtime: 'automatic' }, sourcemap: true });
  sources.set(
    file.href,
    compiled.code + '\n//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify(compiled.map)).toString('base64'),
  );
}
const f = 'const f=globalThis.__rcFixture;';
const noop = (names: string) =>
  names
    .split(',')
    .map((n) => `export const ${n}=()=>null;`)
    .join('');
const stubs: Record<string, string> = {
  '../../pages/HarnessSettings': `import {jsx} from 'react/jsx-runtime';
    export const InstructionsEditor=(p)=>jsx('div',{className:'instructions-editor',children:p.kind});`,
  '../../pages/Login': `import {jsx} from 'react/jsx-runtime';
    export const NeedsCodex=({what})=>jsx('div',{className:'needs-codex',children:'Needs '+what});`,
  // the store's names on the slices the components import them from
  '../../../store/core':
    f +
    `export const toast=(...a)=>f.toasts.push(a); export const setPrefs=(p)=>f.prefs.push(p); export const useStore=(sel)=>sel(f.state);`,
  '../../../store/chats': f + `export const codexUsable=()=>f.ok;`,
  '../../../store/projects': f + `export const currentCwdForNewChat=()=>f.cwd??'/proj';`,
  '../../../store/connection': f + `export const loadConfig=async()=>{f.calls.push('loadConfig');};`,
  '../../../harness/adapters/codex': f + 'export const codexRequest=(m,p)=>{f.calls.push(m);f.params.push([m,p]);return f.answer(m,p);};',
  '../../../session/open': f + `export const openFile=(p)=>{f.opened.push(p);};export const openLink=(u)=>{f.opened.push(u);};`,
  '../../ui/WebLink':
    f +
    `import {jsx} from 'react/jsx-runtime';
    export const WebLink=({href,children})=>jsx('a',{href,onClick:(e)=>{e.preventDefault();f.opened.push(href);},children});`,
  './Plugins':
    f +
    `import {jsx} from 'react/jsx-runtime';
    export const usePlugins=(sel)=>sel({plugins:f.plugins});
    export const ensurePlugins=()=>{f.calls.push('loadPlugins');};
    export const PluginLogo=({p})=>jsx('img',{className:'plugin-logo',alt:p.name});`,
  '../../ui/icons': `import {jsx} from 'react/jsx-runtime';
    ${noop('AlertCircle,ChevronDown,ChevronRight,ArrowUpRight,RefreshCw')}
    export const Spinner=()=>jsx('i',{className:'spinner'});`,
  '../../pages/Settings': `import {jsx,jsxs} from 'react/jsx-runtime';
    export const Group=({title,desc,action,children})=>jsxs('section',{'data-title':typeof title==='string'?title:undefined,children:[desc,action,children]});
    export const Row=({title,desc,children,onClick})=>jsxs('div',{className:'row',onClick,children:[jsx('span',{className:'row-title',children:title}),desc!=null&&jsx('span',{className:'row-desc',children:desc}),children]});
    export const Toggle=({on,onChange,disabled})=>jsx('input',{type:'checkbox',className:'toggle',checked:!!on,disabled:!!disabled,onChange:()=>onChange(!on)});
    export const Select=({value,options,onChange})=>jsx('select',{value,onChange:(e)=>onChange(e.target.value),children:options.map((o)=>jsx('option',{value:o.value,children:o.label},o.value))});
    export const InlineCode=({text})=>jsx('code',{children:text});
    export const groupBy=(arr,key)=>{const out={};for(const a of arr)(out[key(a)]??=[]).push(a);return out;};
    ${noop('EffortsSelect')}`,
};
registerHooks({
  resolve(s, c, next) {
    if (c.parentURL?.startsWith('data:') && s.startsWith('react')) return next(s, { ...c, parentURL: import.meta.url });
    if (c.parentURL && sources.has(c.parentURL) && stubs[s])
      return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(stubs[s]) };
    return next(s, c);
  },
  load(p, c, next) {
    return sources.has(p) ? { format: 'module', shortCircuit: true, source: sources.get(p)! } : next(p, c);
  },
});
export const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
export const { Configuration, ImportSection, Personalization, Hooks, importSource } = await import(url.href);
after(() => window.happyDOM.close());

beforeEach(() => {
  Object.assign(fixture, {
    calls: [],
    params: [],
    toasts: [],
    prefs: [],
    opened: [],
    plugins: null,
    ok: true,
    fail: new Set<string>(),
    cwd: undefined,
    state: { config: null, configError: null, configWarnings: [], codexHome: null, prefs: { importSync: false, importedSources: [] } },
  });
  fixture.answer = async (m: string) => {
    if (fixture.fail.has(m)) throw new Error(`${m} failed`);
    return {};
  };
});

export async function mount(element: ReturnType<typeof createElement>) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  await act(async () => root.render(element));
  const click = (text: string) =>
    act(async () => {
      const b = [...host.querySelectorAll('button')].find((x) => x.textContent === text) as any;
      assert.ok(b, `no ${text} button`);
      b.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
  const row = (title: string) => {
    const r = [...host.querySelectorAll('.row')].find((x) => x.querySelector('.row-title')?.textContent === title) as any;
    assert.ok(r, `no ${title} row`);
    return r;
  };
  const fire = (el: any, type: string) =>
    act(async () => {
      el.dispatchEvent(new window.MouseEvent(type, { bubbles: true }));
    });
  return {
    host,
    click,
    row,
    /** Click a row itself (rows with an onClick). */
    clickRow: (title: string) => fire(row(title), 'click'),
    /** Click a link by its text. */
    clickLink: (text: string) =>
      fire(
        [...host.querySelectorAll('a')].find((x) => x.textContent === text),
        'click',
      ),
    /** Flip the toggle in a row. */
    toggle: (title: string) => fire(row(title).querySelector('input.toggle'), 'click'),
    /** Choose a value in the select of a row. */
    choose: (title: string, value: string) =>
      act(async () => {
        const sel = row(title).querySelector('select');
        sel.value = value;
        sel.dispatchEvent(new window.Event('change', { bubbles: true }));
      }),
    flush: () => act(async () => {}),
    rerender: (next: ReturnType<typeof createElement>) => act(async () => root.render(next)),
    dispose: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
