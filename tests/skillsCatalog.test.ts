import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mount, click, change, flush, fakeStore, byText, popoverStubs, iconStubs, reactProps } from './support/harness-ui-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h, act } = await import('react');
const calls: any[] = [];
const rec =
  (name: string, ret?: any) =>
  (...a: any[]) => (calls.push([name, ...a]), ret);
const PROJ = { id: 'p1', name: 'Proj', roots: [{ path: '/w/proj' }] };
const store = fakeStore<any>({
  savedProjects: [PROJ, { id: 'p2', name: 'Rootless', roots: [] }, { id: 'p3', name: 'Same', roots: [{ path: '/w/proj' }] }],
});
let list: (p: any) => Promise<any> = async () => ({ data: [] });
let write: () => Promise<any> = async () => ({});
let readText: (p: string) => Promise<string | null> = async () => '---\nname: x\n---\n# Body';
let remove: (p: string) => Promise<any> = async () => ({ ok: true });
stubStore({
  useStore: store.useStore,
  navigate: rec('navigate'),
  toast: rec('toast'),
  toastFailure: (what: string) => (e: any) => calls.push(['toast', `${what}: ${e?.message ?? e}`, 'error']),
});
mock.module('../src/session/open.ts', { namedExports: { openLink: rec('open'), revealPath: rec('reveal') } });
mock.module('../src/harness/adapters/codex.ts', {
  namedExports: { codexRequest: (m: string, p: any) => (calls.push([m, p]), m === 'skills/list' ? list(p) : write()) },
});
installNativeStub({
  fs: { readText: (p: string) => readText(p), remove: (p: string) => (calls.push(['remove', p]), remove(p)) },
  clipboard: { write: (t: string) => (calls.push(['copy', t]), Promise.resolve()) },
});
mock.module('../src/components/markdown/Markdown.tsx', {
  namedExports: { Markdown: ({ text }: any) => h('div', { className: 'md' }, text) },
});
mock.module('../src/components/ui/icons.tsx', {
  namedExports: {
    ...iconStubs(),
    Check: () => h('i', { className: 'on' }),
    Spinner: () => h('i', { className: 'spin' }),
  },
});
mock.module('../src/components/ui/Popover.tsx', { namedExports: popoverStubs });
const { SkillsCatalog } = await import('../src/components/harness/codex/SkillsCatalog.tsx');

const sk = (name: string, more: any = {}) => ({
  name,
  description: `${name} does things. More text`,
  path: `/home/me/.codex/skills/${name}/SKILL.md`,
  scope: 'user',
  enabled: false,
  ...more,
});
const names = (root: ParentNode) => [...root.querySelectorAll('.plugin-name')].map((n) => n.textContent);
const sections = (host: HTMLElement) => [...host.querySelectorAll('.skill-section')] as HTMLElement[];
const tabs = (host: HTMLElement) =>
  [...host.querySelectorAll('.skill-tabs button')].map((b) => `${b.textContent}${b.className === 'on' ? '*' : ''}`);
const openSkill = async (host: HTMLElement, name: string) => {
  await click(byText(host, '.plugin-row', new RegExp(`^${name}`)));
  await flush();
  return host.querySelector('.skill-detail') as HTMLElement;
};
const mouseDown = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new (window as any).MouseEvent('mousedown', { bubbles: true }));
  });

const catalog = {
  data: [
    {
      cwd: '/w/proj',
      skills: [
        sk('my-skill', { enabled: true, interface: { displayName: 'Mine', shortDescription: 'short one' } }),
        sk('proj_skill', { path: '/w/proj/.codex/skills/p/SKILL.md' }),
        sk('repo-skill', { path: '/w/proj/tools/r/SKILL.md', scope: 'repo' }),
        sk('dup', { path: '/shared/dup/SKILL.md', scope: 'user' }),
        sk('dup2', { path: '/shared/dup2/SKILL.md', scope: 'repo' }),
        sk('sys', { path: '/sys/SKILL.md', scope: 'system', enabled: true }),
        sk('plug:inner', { enabled: true }),
      ],
    },
    {
      cwd: '/elsewhere',
      skills: [sk('dup', { path: '/shared/dup/SKILL.md', scope: 'repo' }), sk('dup2', { path: '/shared/dup2/SKILL.md', scope: 'user' })],
    },
    {
      skills: [
        sk('loose', { path: '/x/loose/SKILL.md', scope: 'repo' }),
        sk('sys2', { path: '/sys2/SKILL.md', scope: 'system' }),
        sk('sys2', { path: '/sys2/SKILL.md', scope: 'user' }),
      ],
    },
    { cwd: '/none' },
  ],
};

test('loads skills for each project once, ranks duplicates, and lays out Installed and the scope tabs', async () => {
  let release!: (v: any) => void;
  list = () => new Promise((r) => (release = r));
  calls.length = 0;
  const r = await mount(h(SkillsCatalog));
  assert.ok(r.host.querySelector('.spin'));
  assert.deepEqual(calls, [['skills/list', { cwds: ['/w/proj'], forceReload: false }]]);
  await act(async () => release(catalog));
  await flush();
  assert.deepEqual(names(sections(r.host)[0]), ['Mine', 'Sys']);
  assert.equal(sections(r.host)[0].querySelector('.plugin-section-title')?.textContent, 'Installed');
  assert.equal(sections(r.host)[0].querySelector('.plugin-desc')?.textContent, 'short one');
  assert.equal(sections(r.host)[0].querySelectorAll('.on').length, 2);
  assert.deepEqual(tabs(r.host), ['Personal*', 'Proj', 'System']);
  // personal: user skills outside any project, plus repo ones whose cwd isn't a project
  assert.deepEqual(names(sections(r.host)[1]), ['Dup', 'Loose', 'Mine', 'Sys2']);
  await click(byText(r.host, '.skill-tabs button', 'Proj'));
  assert.deepEqual(tabs(r.host), ['Personal', 'Proj*', 'System']);
  assert.deepEqual(names(sections(r.host)[1]), ['Dup2', 'Proj Skill', 'Repo Skill']);
  await click(byText(r.host, '.skill-tabs button', 'System'));
  assert.deepEqual(names(sections(r.host)[1]), ['Sys']);
  assert.equal(sections(r.host)[1].querySelector('.plugin-section-title'), null);

  await change(r.host.querySelector('input[placeholder="Search skills"]'), 'REPO');
  assert.deepEqual(tabs(r.host), ['Proj*']);
  assert.deepEqual(names(sections(r.host)[1]), ['Repo Skill']);
  await change(r.host.querySelector('input[placeholder="Search skills"]'), 'loose does');
  assert.deepEqual(tabs(r.host), ['Personal*']);
  await change(r.host.querySelector('input[placeholder="Search skills"]'), 'zzz');
  assert.equal(r.host.querySelector('.skill-tabs'), null);
  assert.equal(sections(r.host).length, 1);
  await r.unmount();
});

test('the header refreshes, opens skill settings and the docs; a project added reloads; failures keep the list', async () => {
  list = async () => {
    throw new Error('offline');
  };
  calls.length = 0;
  const r = await mount(h(SkillsCatalog));
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', 'offline', 'error']);
  assert.equal(r.host.querySelector('.spin'), null);
  assert.equal(r.host.querySelector('.skill-tabs'), null);
  list = async () => ({ data: [{ cwd: '/w', skills: [sk('a')] }] });
  calls.length = 0;
  await click(r.host.querySelector('[aria-label=Refresh]'));
  await flush();
  assert.deepEqual(calls, [['skills/list', { cwds: ['/w/proj'], forceReload: true }]]);
  assert.deepEqual(names(r.host), ['A']);
  list = async () => {
    throw 'still offline';
  };
  await click(r.host.querySelector('[aria-label=Refresh]'));
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', 'still offline', 'error']);
  assert.deepEqual(names(r.host), ['A']);
  list = async () => ({});
  calls.length = 0;
  store.set({ savedProjects: [...store.get().savedProjects, { id: 'p4', name: 'New', roots: [{ path: '/w/new' }] }] });
  await flush();
  assert.deepEqual(calls, [['skills/list', { cwds: ['/w/proj', '/w/new'], forceReload: false }]]);
  assert.equal(r.host.querySelector('.skill-tabs'), null);
  calls.length = 0;
  await click(r.host.querySelector('[aria-label="Skill settings"]'));
  await click(byText(r.host, 'button', 'Add'));
  assert.deepEqual(calls, [
    ['navigate', { name: 'settings', section: 'plugins', tab: 'skills' }],
    ['open', 'https://developers.openai.com/codex/skills'],
  ]);
  await r.unmount();
});

test("the catalog lists again when a project's folder changes, not for a project without one; only the newest read lands", async () => {
  const saved = store.get().savedProjects;
  const pending: { resolve: (v: any) => void; reject: (e: any) => void }[] = [];
  list = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  calls.length = 0;
  const r = await mount(h(SkillsCatalog));
  // a project with no folder asks nothing new; one moved to another folder lists that folder
  store.set({ savedProjects: [...saved, { id: 'p5', name: 'Bare', roots: [] }] });
  await flush();
  store.set({ savedProjects: [{ ...PROJ, roots: [{ path: '/w/moved' }] }] });
  await flush();
  assert.deepEqual(
    calls.map((c) => c[1].cwds),
    [['/w/proj', '/w/new'], ['/w/moved']],
  );
  // the newer read lands; the older one, answering or failing later, changes nothing
  await act(async () => pending[1].resolve({ data: [{ cwd: '/w/moved', skills: [sk('moved')] }] }));
  await flush();
  await act(async () => pending[0].resolve({ data: [{ cwd: '/w/proj', skills: [sk('old')] }] }));
  await flush();
  assert.deepEqual(names(r.host), ['Moved']);
  await click(r.host.querySelector('[aria-label=Refresh]'));
  await click(r.host.querySelector('[aria-label=Refresh]'));
  calls.length = 0;
  await act(async () => pending[3].resolve({ data: [{ cwd: '/w/moved', skills: [sk('fresh')] }] }));
  await act(async () => pending[2].reject(new Error('late failure')));
  await flush();
  assert.deepEqual(names(r.host), ['Fresh']);
  assert.deepEqual(calls, [], 'a late failure says nothing');
  await r.unmount();
  store.set({ savedProjects: saved });
});

test('a long section shows six and offers the rest', async () => {
  const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => sk(`s-${n}`));
  list = async () => ({ data: [{ cwd: '/w', skills: many }] });
  const r = await mount(h(SkillsCatalog));
  await flush();
  const personal = () => sections(r.host)[1];
  assert.equal(names(personal()).length, 6);
  assert.equal(personal().querySelector('.skill-more')?.textContent, 'See S G, and 0 more');
  await click(personal().querySelector('.skill-more'));
  assert.equal(names(personal()).length, 7);
  assert.equal(personal().querySelector('.skill-more')?.textContent, 'Show less');
  await click(personal().querySelector('.skill-more'));
  assert.equal(names(personal()).length, 6);

  list = async () => ({ data: [{ cwd: '/w', skills: [...many, sk('s-h'), sk('s-i'), sk('s-j')].map((k) => ({ ...k, enabled: true })) }] });
  await click(r.host.querySelector('[aria-label=Refresh]'));
  await flush();
  assert.equal(sections(r.host)[0].querySelector('.skill-more')?.textContent, 'See S G, S H, and 2 more');
  await click(sections(r.host)[0].querySelector('.skill-more'));
  assert.equal(names(sections(r.host)[0]).length, 10);
  assert.equal(names(personal()).length, 6);
  await r.unmount();
});

test('the detail shows the body without front matter, toggles, copies, reveals, closes, and tries the skill', async () => {
  list = async () => ({
    data: [{ cwd: '/w', skills: [sk('my-skill', { enabled: true }), sk('sys', { path: '/sys/SKILL.md', scope: 'system' })] }],
  });
  let releaseBody!: (t: string | null) => void;
  readText = () => new Promise((res) => (releaseBody = res));
  const r = await mount(h(SkillsCatalog));
  await flush();
  let d = await openSkill(r.host, 'My Skill');
  assert.equal(d.getAttribute('role'), 'dialog');
  assert.ok(d.querySelector('.skill-detail-body .spin'));
  assert.equal(d.querySelector('.skill-detail-title')?.textContent, 'My Skill Skill');
  assert.equal(d.querySelector('.skill-detail-desc')?.textContent, 'my-skill does things');
  await act(async () => releaseBody('---\nname: my-skill\n---\n# Hello'));
  assert.equal(d.querySelector('.md')?.textContent, '# Hello');
  assert.equal(byText(d, 'button', 'Uninstall')?.className, 'btn-pill danger outline');

  calls.length = 0;
  await click(d.querySelector('[role=switch]'));
  await flush();
  assert.deepEqual(calls.slice(0, 2), [
    ['skills/config/write', { path: '/home/me/.codex/skills/my-skill/SKILL.md', enabled: false }],
    ['skills/list', { cwds: ['/w/proj', '/w/new'], forceReload: true }],
  ]);
  assert.equal(r.host.querySelector('.skill-detail [role=switch]')?.getAttribute('aria-checked'), 'false');
  write = async () => {
    throw new Error('read only');
  };
  calls.length = 0;
  await click(r.host.querySelector('.skill-detail [role=switch]'));
  await flush();
  assert.deepEqual(calls[1], ['toast', 'read only', 'error']);
  // a write that didn't go through leaves the open detail as it was
  assert.equal(r.host.querySelector('.skill-detail [role=switch]')?.getAttribute('aria-checked'), 'false');
  write = async () => {
    throw 'nope';
  };
  calls.length = 0;
  await click(r.host.querySelector('.skill-detail [role=switch]'));
  await flush();
  assert.deepEqual(calls[1], ['toast', 'nope', 'error']);
  write = async () => ({});

  d = r.host.querySelector('.skill-detail') as HTMLElement;
  calls.length = 0;
  await click(d.querySelector('[aria-label="Skill actions"]'));
  await click(byText(d, '[role=menuitem]', 'Reveal in Finder'));
  assert.equal(d.querySelector('[role=menu]'), null);
  await click(d.querySelector('[aria-label="Skill actions"]'));
  await click(byText(d, '[role=menuitem]', 'Copy path'));
  await flush();
  assert.deepEqual(calls, [
    ['reveal', '/home/me/.codex/skills/my-skill/SKILL.md'],
    ['copy', '/home/me/.codex/skills/my-skill/SKILL.md'],
    ['toast', 'Copied path'],
  ]);

  await mouseDown(d);
  assert.ok(r.host.querySelector('.skill-detail'));
  await mouseDown(r.host.querySelector('.sketch-backdrop')!);
  assert.equal(r.host.querySelector('.skill-detail'), null);

  // a SKILL.md that can't be read says why instead of loading forever
  readText = async () => {
    throw new Error("Error invoking remote method 'fs:readText': Error: EACCES");
  };
  d = await openSkill(r.host, 'My Skill');
  assert.equal(d.querySelector('.skill-detail-body .spin'), null);
  assert.equal(d.querySelector('.skill-detail-body')?.textContent, "Couldn't read SKILL.md: EACCES");
  await click(d.querySelector('[aria-label=Close]'));
  // an answer for a detail that closed is dropped, whether it read or failed
  for (const late of ['read', 'failed'] as const) {
    let settle!: { resolve: (t: string) => void; reject: (e: Error) => void };
    readText = () => new Promise((resolve, reject) => (settle = { resolve, reject }));
    d = await openSkill(r.host, 'My Skill');
    await click(d.querySelector('[aria-label=Close]'));
    await act(async () => (late === 'read' ? settle.resolve('late') : settle.reject(new Error('late'))));
    assert.equal(r.host.querySelector('.skill-detail'), null);
  }

  readText = async () => null;
  await click(byText(r.host, '.skill-tabs button', 'System'));
  d = await openSkill(r.host, 'Sys');
  assert.equal(d.querySelector('.md')?.textContent, '');
  assert.equal(byText(d, 'button', 'Uninstall'), undefined);
  await click(d.querySelector('[aria-label=Close]'));
  assert.equal(r.host.querySelector('.skill-detail'), null);

  d = await openSkill(r.host, 'My Skill');
  const events: any[] = [];
  const onInsert = (e: any) => events.push(e.detail);
  window.addEventListener('insert-skill', onInsert);
  calls.length = 0;
  await click(byText(d, 'button', 'Try now'));
  assert.deepEqual(calls, [['navigate', { name: 'home' }]]);
  assert.equal(r.host.querySelector('.skill-detail'), null);
  await new Promise((res) => setTimeout(res, 170));
  window.removeEventListener('insert-skill', onInsert);
  assert.deepEqual(events, [{ name: 'my-skill', path: '/home/me/.codex/skills/my-skill/SKILL.md', displayName: 'My Skill' }]);
  await r.unmount();
});

test('only a user or repo SKILL.md outside a plugin can be uninstalled', async () => {
  const skills = [
    sk('plugged', { pluginId: 'x', interface: { shortDescription: 'From a plugin' } }),
    sk('relative', { path: 'rel/SKILL.md' }),
    sk('readme', { path: '/home/me/.codex/skills/readme/README.md' }),
    sk('repo-one', { path: '/w/proj/.codex/skills/repo-one/skill.md', scope: 'repo' }),
  ];
  list = async () => ({ data: [{ cwd: '/w/proj', skills }] });
  readText = async () => 'body';
  const r = await mount(h(SkillsCatalog));
  await flush();
  for (const name of ['Plugged', 'Relative', 'Readme']) {
    const d = await openSkill(r.host, name);
    assert.equal(byText(d, 'button', 'Uninstall'), undefined, name);
    if (name === 'Plugged') assert.equal(d.querySelector('.skill-detail-desc')?.textContent, 'From a plugin');
    await click(d.querySelector('[aria-label=Close]'));
  }
  await click(byText(r.host, '.skill-tabs button', 'Proj'));
  const d = await openSkill(r.host, 'Repo One');
  assert.ok(byText(d, 'button', 'Uninstall'));
  await r.unmount();
});

test('uninstalling asks first, deletes the skill folder, and reports failures', async () => {
  list = async () => ({ data: [{ cwd: '/w', skills: [sk('gone'), sk('kept')] }] });
  readText = async () => 'body';
  const r = await mount(h(SkillsCatalog));
  await flush();
  let d = await openSkill(r.host, 'Gone');
  await click(byText(d, 'button', 'Uninstall'));
  assert.equal(d.getAttribute('role'), 'alertdialog');
  assert.equal(
    d.querySelector('.skill-detail-body p')?.textContent,
    'Uninstall Gone? This permanently deletes /home/me/.codex/skills/gone and its contents.',
  );
  assert.equal(d.querySelector('[role=switch]')?.hasAttribute('disabled'), true);
  await click(byText(d, 'button', 'Cancel'));
  assert.equal(d.getAttribute('role'), 'dialog');
  assert.equal(d.querySelector('.md')?.textContent, 'body');

  for (const [result, text] of [
    [{ ok: false, error: 'EPERM' }, 'EPERM'],
    [{ ok: false }, 'Could not uninstall this skill'],
    ['thrown', 'thrown'],
  ] as const) {
    remove = async () => {
      if (result === 'thrown') throw 'thrown';
      return result;
    };
    await click(byText(d, 'button', 'Uninstall'));
    calls.length = 0;
    await click(byText(d, '.skill-detail-foot button', 'Uninstall'));
    await flush();
    assert.deepEqual(calls, [
      ['remove', '/home/me/.codex/skills/gone'],
      ['toast', text, 'error'],
    ]);
    assert.equal(byText(d, '.skill-detail-foot button', 'Uninstall')?.hasAttribute('disabled'), false);
    await click(byText(d, 'button', 'Cancel'));
  }

  let finish!: (v: any) => void;
  remove = () => new Promise((res) => (finish = res));
  list = async () => ({ data: [{ cwd: '/w', skills: [sk('kept')] }] });
  await click(byText(d, 'button', 'Uninstall'));
  calls.length = 0;
  await click(byText(d, '.skill-detail-foot button', 'Uninstall'));
  const busy = byText(d, '.skill-detail-foot button', 'Uninstalling…')!;
  assert.equal(busy.hasAttribute('disabled'), true);
  assert.equal(d.querySelector('[aria-label=Close]')?.hasAttribute('disabled'), true);
  // a second press while the first is running, and a click outside, do nothing
  await act(async () => reactProps(busy).onClick());
  await mouseDown(r.host.querySelector('.sketch-backdrop')!);
  assert.ok(r.host.querySelector('.skill-detail'));
  assert.deepEqual(calls, [['remove', '/home/me/.codex/skills/gone']]);
  await act(async () => finish({ ok: true }));
  await flush();
  assert.deepEqual(calls.slice(1), [
    ['toast', 'Uninstalled Gone'],
    ['skills/list', { cwds: ['/w/proj', '/w/new'], forceReload: true }],
  ]);
  assert.equal(r.host.querySelector('.skill-detail'), null);
  assert.deepEqual(names(sections(r.host)[1]), ['Kept']);
  await r.unmount();
  d = null as any;
});
