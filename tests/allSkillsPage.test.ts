import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mount, click, change, flush, fakeStore, byText, iconStubs } from './support/harness-ui-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h, act } = await import('react');
const calls: unknown[][] = [];
const toasts: unknown[][] = [];
const routes: unknown[] = [];
const PROJECTS = [
  { id: 'p', name: 'P', roots: [{ path: '/w/p' }] },
  { id: 'q', name: 'Q', roots: [] },
];
const store = fakeStore<any>({ savedProjects: PROJECTS });
stubStore({ useStore: store.useStore, navigate: (r: unknown) => routes.push(r), toast: (...a: unknown[]) => toasts.push(a) });
let bin: string | null = '/bin/claude';
mock.module('../src/session/harness/select.ts', { namedExports: { useHarnessStatus: () => ({ bin }) } });
mock.module('../src/store/projects.ts', { namedExports: { currentCwdForNewChat: () => '/w/p' } });
let codexList: () => Promise<any> = async () => ({ data: [] });
let codexWrite: () => Promise<any> = async () => ({});
mock.module('../src/harness/adapters/codex.ts', {
  namedExports: { codexRequest: (m: string, p: unknown) => (calls.push([m, p]), m === 'skills/list' ? codexList() : codexWrite()) },
});
mock.module('../src/components/pages/Settings.tsx', {
  namedExports: {
    Toggle: ({ on, onChange, label }: any) =>
      h('button', { role: 'switch', 'aria-checked': on, 'aria-label': label, onClick: () => onChange(!on) }),
  },
});
mock.module('../src/components/ui/icons.tsx', { namedExports: { ...iconStubs(), Sparkles: () => h('i') } });
mock.module('../src/components/markdown/Markdown.tsx', {
  namedExports: { Markdown: ({ text }: any) => h('div', { className: 'md' }, text) },
});
let catalog: () => Promise<any> = async () => ({ skills: [] });
let plugins: () => Promise<any> = async () => ({ plugins: [], error: null });
let readText: (p: string) => Promise<string | null> = async () => '---\nname: x\n---\n# Body';
let changed: (() => void) | null = null;
installNativeStub({
  claude: { catalog: (...a: unknown[]) => (calls.push(['catalog', ...a]), catalog()) },
  plugins: { list: () => plugins(), onChanged: (cb: () => void) => ((changed = cb), () => (changed = null)) },
  fs: { readText: (p: string) => (calls.push(['read', p]), readText(p)) },
});
const { AllSkills } = await import('../src/components/skills/AllSkills.tsx');

const sk = (name: string, o: Record<string, unknown> = {}) => ({
  name,
  description: `${name} text`,
  path: `/c/${name}/SKILL.md`,
  scope: 'user',
  enabled: true,
  ...o,
});
const cards = (host: HTMLElement) => [...host.querySelectorAll('.plugin-card')] as HTMLElement[];
const line = (c: HTMLElement) => c.querySelector('.plugin-card-meta')?.textContent;
const name = (c: HTMLElement) => c.querySelector('.plugin-card-name')?.textContent;
const cardOf = (host: HTMLElement, title: string) => cards(host).find((c) => name(c) === title)!;

beforeEach(() => {
  store.useStore.setState({ savedProjects: PROJECTS });
  calls.length = 0;
  toasts.length = 0;
  routes.length = 0;
  bin = '/bin/claude';
  codexList = async () => ({ data: [{ cwd: '/w/p', skills: [sk('both'), sk('codex-only', { enabled: false }), sk('both')] }] });
  catalog = async () => ({ skills: ['both', 'claude-only'] });
  plugins = async () => ({ plugins: [], error: null });
  codexWrite = async () => ({});
  readText = async () => '---\nname: x\n---\n# Body';
});

test('one list of every skill, loading first, one switch for Codex and only exceptions said', async () => {
  let release!: (v: any) => void;
  catalog = () => new Promise((r) => (release = r));
  const r = await mount(h(AllSkills));
  assert.match(r.host.textContent!, /Loading/);
  await act(async () => release({ skills: ['both', 'claude-only'] }));
  await flush();
  assert.deepEqual(calls[0], ['skills/list', { cwds: ['/w/p'], forceReload: false }]);
  assert.deepEqual(calls[1], ['catalog', '/bin/claude', '/w/p']);
  assert.deepEqual(cards(r.host).map(name), ['Both', 'Claude Only', 'Codex Only']);
  assert.match(r.host.textContent!, /3 skills/);
  assert.equal(line(cardOf(r.host, 'Both')), 'Only on Codex, Claude Code');
  assert.equal(line(cardOf(r.host, 'Claude Only')), 'Only on Claude Code');
  assert.equal(line(cardOf(r.host, 'Codex Only')), 'Off');
  assert.equal(cardOf(r.host, 'Claude Only').querySelector('[role=switch]'), null);
  // the switch goes through Codex's own path, then every source is read again
  calls.length = 0;
  await click(cardOf(r.host, 'Codex Only').querySelector('[role=switch]'));
  await flush();
  assert.deepEqual(calls[0], ['skills/config/write', { path: '/c/codex-only/SKILL.md', enabled: true }]);
  assert.ok(calls.some((c) => c[0] === 'skills/list'));
  await r.unmount();
  assert.equal(changed, null);
});

test('a switch that fails says why; search filters; a store change reads again', async () => {
  const r = await mount(h(AllSkills));
  await flush();
  codexWrite = async () => Promise.reject(new Error('read-only config'));
  await click(cardOf(r.host, 'Both').querySelector('[role=switch]'));
  await flush();
  assert.deepEqual(toasts, [['read-only config', 'error']]);
  const search = r.host.querySelector('input[aria-label="Search skills"]') as HTMLInputElement;
  await change(search, 'CLAUDE');
  assert.deepEqual(cards(r.host).map(name), ['Claude Only']);
  await change(search, 'nothing here');
  assert.match(r.host.textContent!, /No skills match/);
  calls.length = 0;
  await act(async () => changed!());
  await flush();
  assert.ok(calls.some((c) => c[0] === 'skills/list'));
});

test('store plugin skills join the list; a source that fails is said, with Retry, and the others stay', async () => {
  plugins = async () => ({
    plugins: [
      { id: 'acme@m', enabled: true, harnesses: { acp: false }, spec: { name: 'acme', skills: [{ name: 'tidy', file: '/p/tidy.md' }] } },
    ],
    error: 'one plugin unreadable',
  });
  codexList = async () => Promise.reject(new Error('Codex is not running'));
  const r = await mount(h(AllSkills));
  await flush();
  assert.match(r.host.textContent!, /Couldn't read all skills/);
  assert.match(r.host.textContent!, /Codex skills: Codex is not running/);
  assert.match(r.host.textContent!, /Plugin skills: one plugin unreadable/);
  assert.deepEqual(cards(r.host).map(name), ['Claude Only', 'Both', 'Tidy'].sort());
  assert.equal(line(cardOf(r.host, 'Tidy')), 'Off on Other agents');
  codexList = async () => ({ data: [] });
  plugins = async () => ({ plugins: [], error: null });
  await click(byText(r.host, 'button', 'Retry'));
  await flush();
  assert.doesNotMatch(r.host.textContent!, /Couldn't read all skills/);
});

test('empty says so; no Claude install is not an error; a rejected store list is said', async () => {
  bin = null;
  store.useStore.setState({ savedProjects: [] });
  codexList = async () => ({ data: [] });
  const r = await mount(h(AllSkills));
  await flush();
  assert.deepEqual(calls[0], ['skills/list', { cwds: [], forceReload: false }]);
  assert.equal(
    calls.some((c) => c[0] === 'catalog'),
    false,
  );
  assert.match(r.host.textContent!, /No skills yet/);
  assert.equal(r.host.querySelector('input'), null);
  plugins = async () => Promise.reject(new Error('store down'));
  catalog = async () => Promise.reject(new Error('cli failed'));
  bin = '/bin/claude';
  const r2 = await mount(h(AllSkills));
  await flush();
  assert.match(r2.host.textContent!, /Plugin skills: store down/);
  assert.match(r2.host.textContent!, /Claude Code skills: cli failed/);
  assert.doesNotMatch(r2.host.textContent!, /No skills yet/);
});

test('the detail shows where a skill is on, its SKILL.md and Try now', async () => {
  plugins = async () => ({
    plugins: [
      {
        id: 'acme@m',
        enabled: true,
        harnesses: {},
        spec: { name: 'acme', skills: [{ name: 'tidy', description: 'Tidy up', file: '/p/tidy.md' }] },
      },
    ],
    error: null,
  });
  const r = await mount(h(AllSkills));
  await flush();
  await click(cardOf(r.host, 'Claude Only'));
  assert.equal(
    calls.some((c) => c[0] === 'read'),
    false,
  );
  let dialog = r.host.querySelector('[role=dialog]') as HTMLElement;
  assert.match(dialog.textContent!, /Codex: not available · Claude Code: on · Other agents: not available/);
  assert.equal(dialog.querySelector('.md')?.textContent, '');
  await click(dialog.querySelector('[aria-label=Close]'));
  assert.equal(r.host.querySelector('[role=dialog]'), null);
  // a store skill reads its file; the front matter is dropped
  await click(cardOf(r.host, 'Tidy'));
  await flush();
  dialog = r.host.querySelector('[role=dialog]') as HTMLElement;
  assert.deepEqual(calls.at(-1), ['read', '/p/tidy.md']);
  assert.equal(dialog.querySelector('.md')?.textContent, '# Body');
  const inserted: any[] = [];
  const on = (e: any) => inserted.push(e.detail);
  window.addEventListener('insert-skill', on);
  mock.timers.enable({ apis: ['setTimeout'] });
  await click(byText(dialog, 'button', /Try now/));
  mock.timers.tick(150);
  mock.timers.reset();
  window.removeEventListener('insert-skill', on);
  assert.deepEqual(routes, [{ name: 'home' }]);
  assert.deepEqual(inserted, [{ name: 'acme:tidy', path: '/p/tidy.md', displayName: 'Tidy' }]);
  assert.equal(r.host.querySelector('[role=dialog]'), null);
});

test("a Claude-only skill reads its SKILL.md from the catalog's skillFiles, and the dialog has no Open (the pane belongs to a chat)", async () => {
  catalog = async () => ({
    skills: ['both', 'claude-only', 'built-in'],
    skillFiles: { 'claude-only': { path: '/h/claude-only/SKILL.md', description: 'Only for Claude', scope: 'personal' } },
  });
  readText = async () => '---\nname: claude-only\n---\nThe body';
  const r = await mount(h(AllSkills));
  await flush();
  await click(cardOf(r.host, 'Claude Only'));
  await flush();
  assert.deepEqual(calls.at(-1), ['read', '/h/claude-only/SKILL.md']);
  const dialog = r.host.querySelector('[role=dialog]') as HTMLElement;
  assert.equal(dialog.querySelector('.md')?.textContent, 'The body');
  assert.equal(byText(dialog, 'button', /^Open$/), undefined);
  assert.ok(byText(dialog, 'button', /Try now/));
});

test('a SKILL.md that cannot be read says why; a Codex skill is named as Codex knows it; a backdrop press closes', async () => {
  readText = async () => Promise.reject(new Error('gone'));
  const r = await mount(h(AllSkills));
  await flush();
  await click(cardOf(r.host, 'Codex Only'));
  await flush();
  assert.match(r.host.textContent!, /Couldn't read this skill: gone/);
  const backdrop = r.host.querySelector('.sketch-backdrop')!;
  await act(async () => backdrop.dispatchEvent(new (window as any).MouseEvent('mousedown', { bubbles: true })));
  assert.equal(r.host.querySelector('[role=dialog]'), null);
  readText = async () => null;
  await click(cardOf(r.host, 'Codex Only'));
  await flush();
  assert.equal(r.host.querySelector('.md')?.textContent, 'codex-only text');
  await act(async () =>
    r.host.querySelector('.skill-detail')!.dispatchEvent(new (window as any).MouseEvent('mousedown', { bubbles: true })),
  );
  assert.ok(r.host.querySelector('[role=dialog]'));
});

test('Try now on a Codex skill names it as Codex does', async () => {
  const r = await mount(h(AllSkills));
  await flush();
  await click(cardOf(r.host, 'Codex Only'));
  await flush();
  const inserted: any[] = [];
  const on = (e: any) => inserted.push(e.detail);
  window.addEventListener('insert-skill', on);
  mock.timers.enable({ apis: ['setTimeout'] });
  await click(byText(r.host, 'button', /Try now/));
  mock.timers.tick(150);
  mock.timers.reset();
  window.removeEventListener('insert-skill', on);
  assert.deepEqual(inserted, [{ name: 'codex-only', path: '/c/codex-only/SKILL.md', displayName: 'Codex Only' }]);
});

test('without Codex its skills are not read and its absence is not an error', async () => {
  const r = await mount(h(AllSkills, { codexOk: false }));
  await flush();
  assert.equal(
    calls.some((c) => c[0] === 'skills/list'),
    false,
  );
  assert.doesNotMatch(r.host.textContent!, /Couldn't read/);
  assert.deepEqual(cards(r.host).map(name), ['Both', 'Claude Only']);
});
