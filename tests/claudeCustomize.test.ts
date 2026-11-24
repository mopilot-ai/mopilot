import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mount, click, flush, settingsStubs, rows } from './support/harness-ui-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h } = await import('react');
const calls: any[] = [];
let status: any = { state: 'ready', bin: '/bin/claude' };
let catalog: () => Promise<any> = async () => ({ skills: ['a', 'b'], plugins: [{ name: 'p' }] });
stubStore({ currentCwdForNewChat: () => '/proj', navigate: (r: any) => calls.push(['nav', r]) });
installNativeStub({ claude: { catalog: (bin: string, cwd: string) => (calls.push(['catalog', bin, cwd]), catalog()) } });
mock.module('../src/session/harness/select.ts', { namedExports: { useHarnessStatus: () => status } });
mock.module('../src/components/pages/Settings.tsx', { namedExports: { Group: settingsStubs.Group, Row: settingsStubs.Row } });
mock.module('../src/components/harness/claude/Extensions.tsx', {
  namedExports: {
    ClaudePlugins: ({ bin, plugins, error }: any) =>
      h(
        'div',
        { id: 'plugins', onClick: error?.retry },
        `${bin}:${plugins ? plugins.map((p: any) => p.name).join(',') : 'null'}${error ? `:${error.message}` : ''}`,
      ),
  },
});
// the skill detail is the Skills page's (its own tests are allSkillsPage's): here, what Customize hands it
mock.module('../src/components/skills/SkillDetailDialog.tsx', {
  namedExports: {
    SkillDetailDialog: ({ row, onClose }: any) =>
      h('div', { id: 'detail', onClick: onClose }, `${row.key}|${row.title}|${row.copies.claude?.file}|${row.copies.claude?.on}`),
  },
});
const { ClaudeCustomize } = await import('../src/components/harness/claude/Customize.tsx');

test('without the CLI the page says so and loads nothing; its header opens Claude Code settings', async () => {
  status = { state: 'missing', bin: null };
  calls.length = 0;
  const r = await mount(h(ClaudeCustomize, { tab: 'plugins' }));
  assert.equal(r.host.querySelector('h1')?.textContent, 'Plugins');
  assert.deepEqual(rows(r.host), ["Claude Code isn't installed or signed in"]);
  await click(r.host.querySelector('.btn-white'));
  assert.deepEqual(calls, [['nav', { name: 'settings', section: 'claude', tab: 'extensions' }]]);
  await r.unmount();
});

test('the skills tab shows loading, the found skills, none, or a failed read with Retry', async () => {
  status = { state: 'ready', bin: '/bin/claude' };
  let release!: (v: any) => void;
  catalog = () => new Promise((res) => (release = res));
  calls.length = 0;
  let r = await mount(h(ClaudeCustomize, { tab: 'skills' }));
  assert.equal(r.host.querySelector('h1')?.textContent, 'Skills');
  assert.deepEqual(rows(r.host), ['Loading…']);
  assert.equal(r.host.querySelector('.row i'), null);
  assert.deepEqual(calls, [['catalog', '/bin/claude', '/proj']]);
  await release({ skills: ['a', 'b'], plugins: [] });
  await flush();
  assert.deepEqual(rows(r.host), ['Available']);
  assert.equal(r.host.querySelector('.row i')?.textContent, 'a  b');
  await r.unmount();

  catalog = async () => ({ skills: [], plugins: [] });
  r = await mount(h(ClaudeCustomize, { tab: 'skills' }));
  await flush();
  assert.deepEqual(rows(r.host), ['None found']);
  assert.match(r.host.querySelector('.row i')!.textContent!, /Start a chat to load skills/);
  await r.unmount();

  catalog = async () => {
    throw new Error('boom');
  };
  r = await mount(h(ClaudeCustomize, { tab: 'skills' }));
  await flush();
  // a catalog that couldn't be read is not "None found"
  assert.deepEqual(rows(r.host), ["Couldn't read the skills"]);
  assert.equal(r.host.querySelector('.row i')?.textContent, 'boom');
  catalog = async () => ({ skills: ['c'], plugins: [] });
  await click([...r.host.querySelectorAll('button')].find((b) => b.textContent === 'Retry'));
  await flush();
  assert.deepEqual(rows(r.host), ['Available']);
  await r.unmount();
});

test('the plugins tab hands the catalog to the plugin list, and drops a reply that lands after unmount', async () => {
  catalog = async () => ({ skills: [], plugins: [{ name: 'x' }, { name: 'y' }] });
  let r = await mount(h(ClaudeCustomize, { tab: 'plugins' }));
  await flush();
  assert.equal(r.host.querySelector('#plugins')?.textContent, '/bin/claude:x,y');
  await r.unmount();

  // a failed read reaches the plugin list as its error, and its Retry reads again
  catalog = async () => {
    throw new Error('no cli');
  };
  r = await mount(h(ClaudeCustomize, { tab: 'plugins' }));
  await flush();
  assert.equal(r.host.querySelector('#plugins')?.textContent, '/bin/claude:null:no cli');
  catalog = async () => ({ skills: [], plugins: [{ name: 'z' }] });
  await click(r.host.querySelector('#plugins'));
  await flush();
  assert.equal(r.host.querySelector('#plugins')?.textContent, '/bin/claude:z');
  await r.unmount();

  for (const fail of [false, true]) {
    let settle!: () => void;
    catalog = () =>
      new Promise((res, rej) => (settle = () => (fail ? rej(new Error('late')) : res({ skills: [], plugins: [{ name: 'late' }] }))));
    r = await mount(h(ClaudeCustomize, { tab: 'plugins' }));
    assert.equal(r.host.querySelector('#plugins')?.textContent, '/bin/claude:null');
    await r.unmount();
    settle();
    await flush();
  }
});

test('a listed skill whose SKILL.md was found opens its detail; the others stay text', async () => {
  status = { state: 'ready', bin: '/bin/claude' };
  catalog = async () => ({
    skills: ['a', 'b', 'c', 'constructor'],
    plugins: [],
    skillFiles: { b: { path: '/h/b/SKILL.md', description: '', scope: 'personal' } },
  });
  const r = await mount(h(ClaudeCustomize, { tab: 'skills' }));
  await flush();
  const buttons = [...r.host.querySelectorAll('.row i button')] as HTMLElement[];
  assert.deepEqual(
    buttons.map((b) => b.textContent),
    ['b'],
  );
  assert.equal(r.host.querySelector('.row i')?.textContent, 'a  b  c  constructor');
  assert.equal(r.host.querySelector('#detail'), null);
  await click(buttons[0]);
  assert.equal(r.host.querySelector('#detail')?.textContent, 'b|B|/h/b/SKILL.md|true');
  // closing it leaves the list as it was
  await click(r.host.querySelector('#detail'));
  assert.equal(r.host.querySelector('#detail'), null);
  await r.unmount();
});
