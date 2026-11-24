// The thread sidebar's tiers: a section's label, a project's heading and a list's foot all recede behind the sessions, and only a session takes the selected pill.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reset, fx, thread, project, mountSidebar, flush, byText, mouse } from './support/shell-sidebar-kit.ts';

const { resetSideSessions } = await import('../src/lib/sideSessions.ts');
const { resetNestedHidden } = await import('../src/lib/nestedHidden.ts');
const { markWindowReady } = await import('../src/lib/windowReady.ts');
markWindowReady();

const sheet = (name: string) => readFileSync(new URL(`../src/styles/app/${name}.css`, import.meta.url), 'utf8');
// stand-ins for the tokens the rules read, each a value of its own
const TOKENS: Record<string, string> = {
  '--text': 'rgb(1, 1, 1)',
  '--text-ui': 'rgb(2, 2, 2)',
  '--text-3': 'rgb(3, 3, 3)',
  '--text-4': 'rgb(4, 4, 4)',
  '--row-hover': 'rgb(5, 5, 5)',
  '--row-active': 'rgb(6, 6, 6)',
  '--fs-small': '12px',
  '--fs-micro': '11px',
};
const style = document.createElement('style');
// the sheets in the order app.css imports them
style.textContent = [
  `:root { ${Object.entries(TOKENS)
    .map(([name, value]) => `${name}: ${value};`)
    .join(' ')} }`,
  ...['sidebar', 'sidebar-families', 'sidebar-metrics', 'thread-metrics'].map(sheet),
].join('\n');
before(() => document.head.append(style));
after(() => style.remove());

const css = (el: Element) => getComputedStyle(el);
const ids = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'kid', 'other'];

async function mount(over: Record<string, unknown> = {}) {
  localStorage.clear();
  resetNestedHidden();
  resetSideSessions();
  reset({
    savedProjects: [project('p1', '/work/p1', 'Launch prep'), project('p2', '/work/p2', 'MoPilot'), project('p3', '/work/p3', 'Bare')],
    threadOrder: ids,
    threads: Object.fromEntries(
      ids.map((id, at) => [id, thread(id, { projectId: id === 'other' ? 'p2' : 'p1', cwd: '/work/p1', updatedAt: 100 - at })]),
    ),
    prefs: {
      projectSort: 'custom',
      sidebarProjectOrder: ['p1', 'p2', 'p3'],
      // a pinned project stays listed with no chat, and one section holds them all
      pinnedProjects: ['p3'],
      sidebarSections: [{ id: 's1', name: 'Work' }],
      projectSection: { p1: 's1', p2: 's1', p3: 's1' },
    },
    ...over,
  });
  fx.orchestration = {
    children: {
      kid: { parentId: 'c1', name: 'worker', title: 'Worker', createdAt: 1, useWorktree: false, harness: 'claude', lastReport: null },
    },
    queue: [],
    deliveries: {},
    proposals: {},
  };
  const view = await mountSidebar();
  await flush();
  return view;
}

test('a project heading is dimmer than its sessions, and the home page marks its heading by ink, not by the pill', async () => {
  // the home page: its new chat goes to the newest chat's project, whose heading is the current row
  const view = await mount();
  try {
    const heading = (name: string) => byText(view.host, '.project-row .side-row-label', name).closest<HTMLElement>('.project-row')!;
    const session = view.$('.thread-row');
    assert.equal(css(session).color, TOKENS['--text-ui'], 'sessions are the bright layer');
    assert.equal(css(heading('MoPilot')).color, TOKENS['--text-3'], 'a heading recedes behind them');
    assert.equal(css(heading('MoPilot')).fontSize, TOKENS['--fs-small']);

    const current = heading('Launch prep');
    assert.match(current.className, /selected/);
    assert.equal(css(current).color, TOKENS['--text'], 'the home target reads in full ink');
    assert.equal(css(current).backgroundColor, 'transparent', 'and takes no selected pill');
    // its menu, like a hover, shows the ordinary row wash instead of the pill
    await mouse(current, 'contextmenu');
    assert.match(current.className, /menu-open/);
    assert.equal(css(current).backgroundColor, TOKENS['--row-hover']);
  } finally {
    await view.unmount();
  }
});

test('an open session keeps the selected pill', async () => {
  const view = await mount({ route: { name: 'thread', id: 'c2' } });
  try {
    assert.equal(view.$('.project-row.selected'), null);
    const row = view.$('.thread-row.selected');
    assert.equal(row.getAttribute('data-sidebar-chat'), 'c2');
    assert.equal(css(row).backgroundColor, TOKENS['--row-active']);
    assert.equal(css(row).color, TOKENS['--text']);
  } finally {
    await view.unmount();
  }
});

test('a section label and a list foot step down from the heading, in the thread sidebar only', async () => {
  const view = await mount();
  try {
    const label = byText(view.host, '.side-label', 'Projects');
    assert.equal(css(label).color, TOKENS['--text-4']);
    assert.equal(css(label).fontSize, TOKENS['--fs-micro']);
    // capitals set it apart from the headings under it; the text itself keeps its case
    assert.equal(css(label).textTransform, 'uppercase');
    assert.equal(label.textContent, 'Projects');
    const foot = byText(view.host, '.show-more', 'Show 2 more');
    assert.equal(css(foot).color, TOKENS['--text-4']);
    assert.equal(css(foot).fontSize, TOKENS['--fs-small']);
    // a section the user created is a section label too, over the same headings
    const own = byText(view.host, '.side-section-label', 'Work');
    assert.equal(css(own).color, TOKENS['--text-4']);
    assert.equal(css(own).fontSize, TOKENS['--fs-micro']);
    assert.equal(css(own).textTransform, 'uppercase');
    // an empty project's actions are not a foot: they stay brighter than the note over them
    const bare = byText(view.host, '.project-row .side-row-label', 'Bare').closest('.project-group')!;
    assert.equal(css(byText(bare, '.empty-note', 'No active chats')).color, TOKENS['--text-4']);
    for (const action of ['New chat', 'View archived chats'])
      assert.equal(css(byText(bare, '.show-more', action)).color, TOKENS['--text-3']);
    // the Settings, Review and Scheduled navigation share the class and keep their own type
    const elsewhere = document.createElement('div');
    elsewhere.className = 'side-label';
    document.body.append(elsewhere);
    assert.equal(css(elsewhere).color, TOKENS['--text-3']);
    assert.equal(css(elsewhere).fontSize, TOKENS['--fs-small']);
    assert.notEqual(css(elsewhere).textTransform, 'uppercase');
    elsewhere.remove();
  } finally {
    await view.unmount();
  }
});

test('projects and nested sessions share one disclosure glyph, and a long name fades instead of ending in an ellipsis', async () => {
  const view = await mount();
  try {
    const project = view.$('.project-row .project-disclosure');
    const nested = view.$('[data-sidebar-chat="c1"] .nested-caret svg');
    assert.ok(project && nested);
    assert.equal(
      nested.getAttribute('fill'),
      project.getAttribute('fill'),
      'the nested caret is the outline chevron, not a filled triangle',
    );
    assert.notEqual(nested.getAttribute('fill'), 'currentColor');
    assert.equal(nested.getAttribute('width'), project.getAttribute('width'));

    for (const name of [view.$('.project-row .side-row-label'), view.$('.thread-row .side-row-label')]) {
      assert.notEqual(css(name).textOverflow, 'ellipsis');
      // the fade's width is 0 until the name overflows: its scroll timeline is what turns it on
      assert.equal(css(name).getPropertyValue('--label-fade'), '0px');
      assert.equal(css(name).animationTimeline, 'scroll(self inline)');
    }
    // MorphText's layer would end the name in its own ellipsis and leave the label nothing to scroll (the real app's
    // rows; this kit renders the name bare), so inside a row's name the layer keeps the text's width
    const name = document.createElement('span');
    name.className = 'side-row-name';
    name.innerHTML = '<span class="side-row-label"><span class="morph-text"><span class="morph-layer">A name</span></span></span>';
    document.body.append(name);
    const layer = css(name.querySelector('.morph-layer')!);
    assert.equal(layer.overflow, 'visible');
    assert.equal(layer.minWidth, 'max-content');
    // a name crossfading out is held inside the box, so a long one leaving does not make the label overflow and
    // fade the short one coming in
    const leaving = document.createElement('span');
    leaving.className = 'morph-layer morph-out';
    name.querySelector('.morph-text')!.prepend(leaving);
    const out = css(leaving);
    assert.equal(out.overflow, 'hidden');
    assert.equal(out.minWidth, '0');
    assert.equal(out.maxWidth, '100%');
    assert.notEqual(out.textOverflow, 'ellipsis');
    name.remove();
    assert.match(sheet('sidebar-families'), /@keyframes side-label-clipped \{\s*from,\s*to \{\s*--label-fade: 18px;/);
  } finally {
    await view.unmount();
  }
});
