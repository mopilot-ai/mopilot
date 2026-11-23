// The side panel's sidebar (electron/chrome-extension/src/panelSidebar.mjs): search, projects as filters and as where a new chat goes, scheduled tasks, pinned chats, recents (active or archived, by project), and each chat's Pin and Open in MoPilot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick } from './support/extension-background/fixture.ts';
import { panelPage } from './support/side-panel-page.ts';

const { startSidePanel } = await import('../electron/chrome-extension/src/sidePanel.mjs');
const { whenOf } = await import('../electron/chrome-extension/src/panelSidebar.mjs');

const CHATS = [
  { id: 'a', title: 'Flights to Tokyo', project: 'Travel', pinned: true, state: 'waiting' },
  { id: 'b', title: 'Expense form', project: 'Work', pinned: false, state: 'running' },
  { id: 'c', title: null, project: null, pinned: false, state: 'idle' },
  { id: 'd', title: 'Hotel in Osaka', project: 'Travel', pinned: false, state: 'idle' },
];
const NOW = new Date(2026, 9, 22, 9, 0);

/** The panel, connected, with MoPilot's chats, projects and scheduled tasks; requests are kept. */
async function sidebar(o: { fail?: string[]; archived?: any[] } = {}) {
  const pins: any[] = [];
  const p = panelPage({
    reply: (m: any) => {
      if (m.type !== 'panel') return { status: 'connected' };
      if (o.fail?.includes(m.method)) return { status: 'connected', error: `No ${m.method} now.` };
      if (m.method === 'harnesses') return { status: 'connected', result: { harnesses: [{ id: 'claude', label: 'Claude Code' }] } };
      if (m.method === 'recent')
        return { status: 'connected', result: { chats: m.params.archived ? (o.archived ?? []) : CHATS.map((c) => ({ ...c })) } };
      if (m.method === 'projects')
        return {
          status: 'connected',
          result: {
            projects: [
              { id: 'p1', name: 'Travel' },
              { id: 'p2', name: 'Work' },
            ],
          },
        };
      if (m.method === 'scheduled')
        return {
          status: 'connected',
          result: {
            tasks: [
              { id: 't1', name: 'Morning brief', next: new Date(2026, 9, 22, 15, 2).getTime() },
              { id: 't2', name: 'Water the plants', next: null },
            ],
          },
        };
      if (m.method === 'pin') return pins.push(m.params), { status: 'connected', result: { pinned: m.params.pinned } };
      if (m.method === 'start') return { status: 'connected', result: { chatId: 'new-1' } };
      return { status: 'connected', result: { rows: [], state: 'idle' } };
    },
  });
  await startSidePanel(p.g).ready;
  await tick();
  return { p, pins, rows: () => p.els.recents.children };
}
const title = (row: any) => row.children[0].children[1].textContent;

test('☰ and the title open the sidebar: projects, scheduled tasks, pinned on top, recents with their turn', async () => {
  const { p } = await sidebar();
  assert.equal(p.els.side.hidden, false);
  p.els.side.listeners.click();
  await tick();
  await tick();
  assert.equal(p.els.sidebar.hidden, false);
  assert.equal(p.els.side.attrs['aria-expanded'], 'true');
  assert.deepEqual(
    p
      .sent()
      .filter((m: any) => ['recent', 'projects', 'scheduled'].includes(m.method))
      .map((m: any) => [m.method, m.params]),
    [
      // the sidebar's lists, read as it opens
      ['recent', { limit: 200, archived: false }],
      ['projects', {}],
      ['scheduled', {}],
    ],
  );
  assert.deepEqual(
    p.els.projects.children.map((b: any) => b.children[0].textContent),
    ['All chats', 'Travel', 'Work'],
  );
  assert.equal(p.els.tasks.children.length, 2);
  assert.equal(p.els.tasks.children[1].children[1].textContent, 'Paused');
  // pinned on top, the rest under Recents with the state of their turn
  assert.deepEqual(p.els.pinned.children.map(title), ['Flights to Tokyo']);
  assert.equal(p.els['pinned-head'].hidden, false);
  assert.deepEqual(p.els.recents.children.map(title), ['Expense form', 'New chat', 'Hotel in Osaka']);
  assert.equal(p.els.pinned.children[0].children[0].children[0].className, 'dot wait');
  assert.equal(p.els.pinned.children[0].children[0].children[2].textContent, 'Waiting');
  // a scheduled task opens the app's Scheduled page
  p.els.tasks.children[0].listeners.click();
  await tick();
  assert.deepEqual(p.sent().at(-1), { type: 'panel', method: 'open', params: { page: 'scheduled' } });
  // closed by ×, by ☰ again, or by the title
  p.els['side-close'].listeners.click();
  assert.equal(p.els.sidebar.hidden, true);
  p.els.title.listeners.click();
  await tick();
  assert.equal(p.els.sidebar.hidden, false);
  p.els.side.listeners.click();
  assert.equal(p.els.sidebar.hidden, true);
  assert.equal(p.els.side.attrs['aria-expanded'], 'false');
});

test('search and a project filter the chats; a chat opens in the panel; New chat goes into the project picked', async () => {
  const { p } = await sidebar();
  p.els.side.listeners.click();
  await tick();
  await tick();
  p.els.search.listeners.input({ target: { value: '  osaka ' } });
  assert.deepEqual(p.els.recents.children.map(title), ['Hotel in Osaka']);
  assert.equal(p.els['pinned-head'].hidden, true, 'no pinned section while searching');
  p.els.search.listeners.input({ target: { value: 'nothing like this' } });
  assert.equal(p.els.recents.children[0].textContent, 'No chats match.');
  p.els.search.listeners.input({ target: {} });
  // a project: its chats only, picked again it clears
  p.els.projects.children[1].listeners.click();
  assert.equal(p.els.projects.children[1].className, 'row-chat on');
  assert.deepEqual([...p.els.pinned.children, ...p.els.recents.children].map(title), ['Flights to Tokyo', 'Hotel in Osaka']);
  p.els.projects.children[1].listeners.click();
  assert.equal(p.els.recents.children.length, 3);
  p.els.projects.children[2].listeners.click();
  p.els.projects.children[0].listeners.click();
  assert.equal(p.els.projects.children[0].className, 'row-chat on', 'All chats');
  // New chat in Travel: the chip says where it goes; the start carries the project
  p.els.projects.children[1].listeners.click();
  p.els['side-new'].listeners.click();
  assert.equal(p.els.sidebar.hidden, true);
  assert.equal(p.els.project.hidden, false);
  assert.equal(p.els['project-name'].textContent, 'In Travel');
  // its / menu is read for the project's folder
  p.els.text.value = '/';
  p.els.text.listeners.input();
  await tick();
  assert.deepEqual(
    p
      .sent()
      .filter((m: any) => m.method === 'commands')
      .at(-1).params,
    { harness: 'claude', projectId: 'p1' },
  );
  p.els.text.value = 'Find a ryokan';
  p.els.composer.listeners.submit({ preventDefault: () => undefined });
  await tick();
  assert.deepEqual(p.sent().find((m: any) => m.method === 'start').params.projectId, 'p1');
  // the next new chat is not in it; × takes the chip off before sending
  p.els.new.listeners.click();
  assert.equal(p.els.project.hidden, true);
  p.els.side.listeners.click();
  await tick();
  await tick();
  p.els.projects.children[2].listeners.click();
  p.els['side-new'].listeners.click();
  assert.equal(p.els['project-name'].textContent, 'In Work');
  p.els['project-off'].listeners.click();
  assert.equal(p.els.project.hidden, true);
  // the / menu starts over for the home folder (no skill picked for the project stays)
  assert.equal(p.els.skills.hidden, true);
  // a chat from the list opens in the panel (a pinned one too), its title in the bar
  p.els.side.listeners.click();
  await tick();
  await tick();
  // the sidebar keeps its filter; All chats clears it
  assert.equal(p.els.projects.children[2].className, 'row-chat on');
  p.els.projects.children[0].listeners.click();
  p.els.pinned.children[0].children[0].listeners.click();
  await tick();
  assert.equal(p.els.sidebar.hidden, true);
  assert.equal(p.els.title.textContent, 'Flights to Tokyo');
  assert.deepEqual(p.sent().at(-1), { type: 'panel', method: 'read', params: { chatId: 'a' } });
});

test('archived chats, by project; each chat’s ⋯ pins or unpins it in MoPilot and opens it there', async () => {
  const { p, pins } = await sidebar({ archived: [{ id: 'z', title: 'Old trip', project: 'Travel', pinned: true, state: 'gone' }] });
  p.els.side.listeners.click();
  await tick();
  await tick();
  // grouped by project, projects first in the order their newest chat comes, then the ones with none
  p.els.group.listeners.change({ target: { checked: true } });
  assert.deepEqual(
    p.els.recents.children.map((x: any) => (x.className === 'group-head' ? `# ${x.textContent}` : title(x))),
    ['# Work', 'Expense form', '# Travel', 'Hotel in Osaka', '# No project', 'New chat'],
  );
  p.els.group.listeners.change({ target: { checked: false } });
  // ⋯: Pin (or Unpin), Open in MoPilot; ⋯ again closes it
  const row = p.els.recents.children[0];
  row.children[1].listeners.click();
  const menu = row.children[2];
  assert.equal(menu.attrs.role, 'menu');
  assert.deepEqual(
    menu.children.map((b: any) => b.textContent),
    ['Pin', 'Open in MoPilot'],
  );
  row.children[1].listeners.click();
  assert.equal(menu.removed, true);
  row.children[1].listeners.click();
  row.children[2 + 1].children[0].listeners.click();
  await tick();
  assert.deepEqual(pins, [{ chatId: 'b', pinned: true }]);
  assert.deepEqual(p.els.pinned.children.map(title), ['Flights to Tokyo', 'Expense form']);
  // an unpin from the pinned list
  const pinnedRow = p.els.pinned.children[0];
  pinnedRow.children[1].listeners.click();
  assert.equal(pinnedRow.children[2].children[0].textContent, 'Unpin');
  pinnedRow.children[2].children[1].listeners.click();
  await tick();
  assert.deepEqual(p.sent().at(-1), { type: 'panel', method: 'open', params: { chatId: 'a' } });
  // the archive: its own list, no pinned section
  p.els['recents-filter'].listeners.change({ target: { value: 'archived' } });
  await tick();
  await tick();
  assert.deepEqual(
    p
      .sent()
      .filter((m: any) => m.method === 'recent')
      .at(-1).params,
    { limit: 200, archived: true },
  );
  assert.deepEqual(p.els.recents.children.map(title), ['Old trip']);
  // a state the list doesn't know: a plain dot
  assert.equal(p.els.recents.children[0].children[0].children[0].className, 'dot ');
  assert.equal(p.els['pinned-head'].hidden, true);
  // View all and Extension settings
  p.els['side-all'].listeners.click();
  await tick();
  assert.deepEqual(p.sent().at(-1), { type: 'panel', method: 'open', params: {} });
  p.chrome.runtime.openOptionsPage = async () => p.chrome.log.push(['runtime.openOptionsPage']);
  p.els['side-settings'].listeners.click();
  await tick();
  assert.deepEqual(p.chrome.log.at(-1), ['runtime.openOptionsPage']);
  p.chrome.runtime.openOptionsPage = async () => {
    throw new Error('No options page.');
  };
  p.els['side-settings'].listeners.click();
  await tick();
  await tick();
  assert.equal(p.els.error.textContent, 'No options page.');
});

test('a list MoPilot can’t give says why in its place; a pin it refuses says why too; empty lists say so', async () => {
  const { p } = await sidebar({ fail: ['recent', 'projects', 'scheduled', 'pin'] });
  p.els.side.listeners.click();
  await tick();
  await tick();
  assert.equal(p.els.recents.children[0].textContent, 'No recent now.');
  assert.equal(p.els.projects.children[0].textContent, 'No projects now.');
  assert.equal(p.els.tasks.children[0].textContent, 'No scheduled now.');
  const ok = await sidebar({ fail: ['pin', 'projects', 'scheduled'] });
  ok.p.els.side.listeners.click();
  await tick();
  await tick();
  assert.equal(ok.p.els.projects.children[0].textContent, 'No projects now.');
  const row = ok.p.els.recents.children[0];
  row.children[1].listeners.click();
  row.children[2].children[0].listeners.click();
  await tick();
  await tick();
  assert.equal(ok.p.els.error.textContent, 'No pin now.');
  // the archive empty, and lists MoPilot gives nothing for
  ok.p.els['recents-filter'].listeners.change({ target: { value: 'archived' } });
  await tick();
  await tick();
  assert.equal(ok.p.els.recents.children[0].textContent, 'No archived chats.');
  const bare = panelPage({ reply: (m: any) => ({ status: 'connected', result: m.method === 'harnesses' ? { harnesses: [] } : {} }) });
  await startSidePanel(bare.g).ready;
  await tick();
  bare.els.side.listeners.click();
  await tick();
  await tick();
  assert.equal(bare.els.recents.children[0].textContent, 'No chats yet.');
  assert.equal(bare.els.projects.children[0].textContent, 'No projects yet.');
  assert.equal(bare.els.tasks.children[0].textContent, 'No scheduled tasks.');
});

test('a scheduled task’s next time reads as the app’s list says it', () => {
  assert.equal(whenOf(new Date(2026, 9, 22, 15, 2).getTime(), NOW), 'Today 3:02 PM');
  assert.equal(whenOf(new Date(2026, 9, 23, 9, 0).getTime(), NOW), 'Tomorrow 9:00 AM');
  assert.equal(whenOf(new Date(2026, 10, 3, 18, 30).getTime(), NOW), 'Nov 3 6:30 PM');
  assert.equal(whenOf(null, NOW), 'Paused');
  assert.match(whenOf(Date.now()), /^Today /);
});
