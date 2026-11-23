// The sidebar write tools (electron/capabilities/tools/sidebarTools.cjs): pins and unread dots on one's own or another
// chat, and sections that hold saved projects, with the user asked before a section is renamed or deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { registerSidebarTools } = require('../electron/capabilities/tools/sidebarTools.cjs');

function setup(over: { prefs?: any; allow?: boolean; saves?: boolean; ids?: string[] } = {}) {
  const prefs: any = over.prefs ?? {};
  const metas = new Map<string, any>([
    ['me', { meta: {} }],
    ['other', { meta: {} }],
    ['momo', { meta: { momo: 'main' } }],
  ]);
  const patches: any[] = [];
  const asked: string[] = [];
  const ids = [...(over.ids ?? ['s1', 's2', 's3'])];
  const projects = [
    { id: 'p1', name: 'Alpha', path: '/work/alpha' },
    { id: 'p2', name: 'Beta', path: '/work/beta' },
    { id: 'p3', name: 'Beta', path: '/other/beta' },
  ];
  const r = new Registry();
  registerSidebarTools(r, {
    owner: (ctx: any) => (ctx.segmentId === 'seg' ? ctx.chatId : null),
    records: () => metas,
    patchMeta: (id: string, patch: any) => {
      patches.push([id, patch]);
      return true;
    },
    prefs: () => prefs,
    patchPrefs: (set: any) => {
      if (over.saves === false) return false;
      Object.assign(prefs, set);
      return true;
    },
    projects: () => projects,
    ask: async (chat: string, summary: string) => (asked.push(`${chat}: ${summary}`), over.allow !== false),
    newId: () => ids.shift() ?? 'zz',
  });
  const call = async (tool: string, args: any, chat = 'me', seg = 'seg') => {
    const res = await r.invoke(chat, seg, tool, args);
    return res.ok ? JSON.parse(res.content[0].text) : { error: res.error };
  };
  return { r, call, prefs, patches, asked };
}

test('the tools: names and policies', () => {
  const t = setup();
  assert.deepEqual(
    t.r.list().map((x: any) => [x.name, x.policy]),
    [
      ['set_pinned', 'act'],
      ['set_unread', 'act'],
      ['list_sections', 'observe'],
      ['create_section', 'act'],
      ['rename_section', 'act'],
      ['delete_section', 'irreversible'],
      ['move_project', 'act'],
    ],
  );
});

test('a pin or unread dot: this chat ("self" or empty), another chat, never MoMo’s or an unknown one', async () => {
  const t = setup();
  assert.deepEqual(await t.call('set_pinned', { session_id: 'self', pinned: true }), {
    session_id: 'me',
    pinned: true,
    changed: true,
    said: 'Pinned it in the sidebar.',
  });
  assert.equal((await t.call('set_pinned', { session_id: '', pinned: false })).said, 'Unpinned it.');
  assert.equal((await t.call('set_unread', { session_id: 'other', unread: true })).said, 'Marked it unread.');
  assert.equal((await t.call('set_unread', { session_id: 'other', unread: false })).said, 'Marked it read.');
  assert.deepEqual(t.patches, [
    ['me', { pinned: true }],
    ['me', { pinned: false }],
    ['other', { unread: true }],
    ['other', { unread: false }],
  ]);
  // another chat's row asks the user first; this chat's own does not
  assert.deepEqual(t.asked, ['me: set the unread dot of another chat', 'me: clear the unread dot of another chat']);
  assert.equal((await t.call('set_pinned', { session_id: 'momo', pinned: true })).error.code, 'not_found');
  assert.equal((await t.call('set_pinned', { session_id: 'nope', pinned: true })).error.code, 'not_found');
  assert.equal((await t.call('set_pinned', { session_id: 'self', pinned: true }, 'me', 'stranger')).error.code, 'no_owner');
  assert.equal(t.patches.length, 4);
  const no = setup({ allow: false });
  assert.equal((await no.call('set_pinned', { session_id: 'other', pinned: true })).error.code, 'denied');
  assert.equal((await no.call('set_pinned', { session_id: 'self', pinned: true })).changed, true);
  assert.deepEqual(no.patches, [['me', { pinned: true }]]);
  assert.deepEqual(no.asked, ['me: set the pin of another chat']);
});

test('sections: create, list, file a project, take it out; a repeated name reuses the section', async () => {
  const t = setup();
  const made = await t.call('create_section', { name: '  Work   stuff ' });
  assert.deepEqual([made.id, made.name, made.created], ['s1', 'Work stuff', true]);
  const again = await t.call('create_section', { name: 'work STUFF' });
  assert.deepEqual([again.id, again.created], ['s1', false]);
  assert.equal((await t.call('create_section', { name: 'Home' })).id, 's2');
  assert.equal((await t.call('move_project', { project: 'alpha', section_id: 's1' })).said, 'Filed it under the section.');
  assert.equal((await t.call('move_project', { project: '/work/beta', section_id: 's2' })).project, 'Beta');
  assert.deepEqual(await t.call('list_sections', {}), {
    sections: [
      { id: 's1', name: 'Work stuff', projects: ['Alpha'] },
      { id: 's2', name: 'Home', projects: ['Beta'] },
    ],
    unsectioned: ['Beta'],
  });
  assert.equal((await t.call('move_project', { project: 'Alpha', section_id: null })).said, 'Took it out of its section.');
  assert.deepEqual(t.prefs.projectSection, { p2: 's2' });
});

test('section ids stay unique, names and projects are checked, and the cap holds', async () => {
  const t = setup({ prefs: { sidebarSections: [{ id: 's1', name: 'Taken' }] }, ids: ['s1', 's9'] });
  assert.equal((await t.call('create_section', { name: 'New' })).id, 's9');
  assert.equal((await t.call('create_section', { name: '   ' })).error.code, 'bad_args');
  assert.equal((await t.call('create_section', { name: 'x'.repeat(81) })).error.code, 'bad_args');
  assert.equal((await t.call('move_project', { project: 'Beta', section_id: 's1' })).error.code, 'ambiguous');
  assert.equal((await t.call('move_project', { project: 'Gamma', section_id: 's1' })).error.code, 'not_found');
  assert.equal((await t.call('move_project', { project: 'Alpha', section_id: 'nope' })).error.code, 'not_found');
  const full = setup({ prefs: { sidebarSections: Array.from({ length: 50 }, (_, i) => ({ id: `i${i}`, name: `S${i}` })) } });
  assert.equal((await full.call('create_section', { name: 'One more' })).error.code, 'too_many');
  const odd = setup({ prefs: { sidebarSections: 'x', projectSection: 'y' } });
  assert.deepEqual(await odd.call('list_sections', {}), { sections: [], unsectioned: ['Alpha', 'Beta', 'Beta'] });
});

test('a rename or delete asks the user first, and a refusal changes nothing', async () => {
  const t = setup({ prefs: { sidebarSections: [{ id: 'a', name: 'Old' }], projectSection: { p1: 'a', p2: 'zz' } } });
  assert.equal((await t.call('rename_section', { section_id: 'a', name: 'Fresh' })).name, 'Fresh');
  assert.deepEqual(t.prefs.sidebarSections, [{ id: 'a', name: 'Fresh' }]);
  assert.equal((await t.call('delete_section', { section_id: 'a' })).id, 'a');
  assert.deepEqual(t.prefs.sidebarSections, []);
  assert.deepEqual(t.prefs.projectSection, { p2: 'zz' });
  assert.deepEqual(t.asked, ['me: rename the sidebar section “Old” to “Fresh”', 'me: delete the sidebar section “Fresh”']);

  const no = setup({ prefs: { sidebarSections: [{ id: 'a', name: 'Old' }] }, allow: false });
  assert.equal((await no.call('rename_section', { section_id: 'a', name: 'X' })).error.code, 'denied');
  assert.equal((await no.call('delete_section', { section_id: 'a' })).error.code, 'denied');
  assert.deepEqual(no.prefs.sidebarSections, [{ id: 'a', name: 'Old' }]);
  assert.equal((await no.call('rename_section', { section_id: 'a', name: '' })).error.code, 'bad_args');
  assert.equal((await no.call('rename_section', { section_id: 'zz', name: 'X' })).error.code, 'not_found');
  const dup = setup({
    prefs: {
      sidebarSections: [
        { id: 'a', name: 'Work' },
        { id: 'b', name: 'Play' },
      ],
    },
  });
  assert.equal((await dup.call('rename_section', { section_id: 'b', name: 'work' })).error.code, 'exists');
  assert.equal((await dup.call('rename_section', { section_id: 'b', name: 'PLAY' })).name, 'PLAY');
  assert.equal(dup.asked.length, 1, 'a rename to another section’s name asks nothing');
});

test('a section removed while its card waited is not renamed or deleted', async () => {
  const prefs: any = { sidebarSections: [{ id: 'a', name: 'Old' }] };
  const r = new Registry();
  registerSidebarTools(r, {
    owner: (ctx: any) => ctx.chatId,
    records: () => new Map(),
    patchMeta: () => true,
    prefs: () => prefs,
    patchPrefs: (set: any) => !!Object.assign(prefs, set),
    projects: () => [],
    // the user deletes it by hand while the card is up
    ask: async () => ((prefs.sidebarSections = []), true),
  });
  const res = await r.invoke('me', 'seg', 'rename_section', { section_id: 'a', name: 'New' });
  assert.equal(res.error.code, 'not_found');
  assert.deepEqual(prefs.sidebarSections, []);
  prefs.sidebarSections = [{ id: 'a', name: 'Old' }];
  assert.equal((await r.invoke('me', 'seg', 'delete_section', { section_id: 'a' })).error.code, 'not_found');
});

test('a prefs write that does not save is an error, not a success', async () => {
  const t = setup({ saves: false });
  assert.equal((await t.call('create_section', { name: 'Home' })).error.code, 'save_failed');
});

test('the default id is short and unused', async () => {
  const r = new Registry();
  const prefs: any = {};
  registerSidebarTools(r, {
    owner: (ctx: any) => ctx.chatId,
    records: () => new Map(),
    patchMeta: () => true,
    prefs: () => prefs,
    patchPrefs: (set: any) => !!Object.assign(prefs, set),
    projects: () => [],
    ask: async () => true,
  });
  const made = JSON.parse((await r.invoke('me', 'seg', 'create_section', { name: 'A' })).content[0].text);
  assert.match(made.id, /^[a-z0-9]+$/);
});
