// How the chat list is laid out: one section per project in the computer's order, each chat listed once in its project, narrowed by a search.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const groupsPath = '../mobile/src/presentation/chatGroups';
const { groupChats, projectName } = await import(groupsPath);

const chats = [
  { id: '1', title: 'Fix login', state: 'waiting', project: 'App' },
  { id: '2', title: 'Write docs', state: 'idle', project: 'Backend' },
  { id: '3', title: 'Refactor', state: 'running', project: 'App' },
  { id: '4', title: undefined, state: 'idle', project: null },
  { id: '5', title: 'Lost project', project: '' },
];

test('a project shows by its name; none is "No project"', () => {
  assert.equal(projectName('App'), 'App');
  assert.equal(projectName(null), 'No project');
  assert.equal(projectName(undefined), 'No project');
  assert.equal(projectName(''), 'No project');
});

test('chats group by project in the order the computer listed them, a waiting chat in its own project', () => {
  const { projects } = groupChats(chats, '');
  assert.deepEqual(
    projects.map((g: any) => [g.name, g.chats.map((c: any) => c.id)]),
    [
      ['App', ['1', '3']],
      ['Backend', ['2']],
      ['No project', ['4', '5']],
    ],
  );
});

test('a search matches the title or the project name, ignoring case and spaces around it, and an untitled chat by "Untitled chat"', () => {
  assert.deepEqual(
    groupChats(chats, '  LOGIN ').projects.map((g: any) => [g.name, g.chats.map((c: any) => c.id)]),
    [['App', ['1']]],
  );
  assert.deepEqual(
    groupChats(chats, 'backend').projects.map((g: any) => g.name),
    ['Backend'],
  );
  assert.deepEqual(
    groupChats(chats, 'untitled').projects[0].chats.map((c: any) => c.id),
    ['4'],
  );
  // nothing listed is no section and no sub-session (the function that names a project is not data)
  for (const none of [groupChats(chats, 'nothing like it'), groupChats([], '')])
    assert.deepEqual([none.projects, none.nested], [[], new Map()]);
});

test('two projects of one name stay two groups by project id, the second numbered; a computer that sends no id is grouped by name', () => {
  const twins = [
    { id: '1', title: 'One', project: 'app', projectId: 'a1' },
    { id: '2', title: 'Two', project: 'app', projectId: 'a2' },
    { id: '3', title: 'Three', project: 'app', projectId: 'a1' },
    { id: '4', title: 'Four', project: 'docs', projectId: 'd1' },
    { id: '5', title: 'Five', project: 'app', projectId: 'a3' },
  ];
  const { projects } = groupChats(twins, '');
  assert.deepEqual(
    projects.map((g: any) => [g.key, g.name, g.chats.map((c: any) => c.id)]),
    [
      ['id:a1', 'app', ['1', '3']],
      ['id:a2', 'app (2)', ['2']],
      ['id:d1', 'docs', ['4']],
      ['id:a3', 'app (3)', ['5']],
    ],
  );
  assert.deepEqual(
    groupChats(
      twins.map(({ projectId, ...c }) => c),
      '',
    ).projects.map((g: any) => [g.key, g.name]),
    [
      ['name:app', 'app'],
      ['name:docs', 'docs'],
    ],
  );
  // the search still reads the project's own name
  assert.deepEqual(groupChats(twins, 'APP').projects.length, 3);
});

test('two projects of one name are told apart by the hint the Mac sends where it sends one, else the second is numbered; a row names its project the same way', () => {
  const hinted = [
    { id: '1', title: 'One', project: 'app', projectId: 'a1', projectHint: 'work' },
    { id: '2', title: 'Two', project: 'app', projectId: 'a2', projectHint: 'play' },
    { id: '3', title: 'Three', project: 'docs', projectId: 'd1' },
  ];
  const s = groupChats(hinted, '');
  assert.deepEqual(
    s.projects.map((g: any) => g.name),
    ['app · work', 'app · play', 'docs'],
    'both are told apart by their folders, neither is numbered',
  );
  assert.deepEqual(
    hinted.map((c) => s.labelOf(c)),
    ['app · work', 'app · play', 'docs'],
    'a row that names its project says the same',
  );
  // one with a hint and one without (a folder the Mac did not name): the hinted one by it, the other keeps the name
  const mixed = [
    { id: '1', title: 'One', project: 'app', projectId: 'a1', projectHint: 'work' },
    { id: '2', title: 'Two', project: 'app', projectId: 'a2' },
    { id: '3', title: 'Three', project: 'app', projectId: 'a3' },
  ];
  assert.deepEqual(
    groupChats(mixed, '').projects.map((g: any) => g.name),
    ['app · work', 'app', 'app (2)'],
  );
  // a project alone with its name never carries a hint, whatever a Mac sends
  assert.equal(
    groupChats([{ id: '1', title: 'One', project: 'app', projectId: 'a1' }], '').labelOf({ id: '1', project: 'app', projectId: 'a1' }),
    'app',
  );
  assert.equal(groupChats([], '').labelOf({ id: 'x', project: null }), 'No project');
});

test('a pinned chat keeps its place in its project (the drawer lists the pinned ones)', () => {
  const pinnedChats = [
    { id: 'p', title: 'Pinned', state: 'idle', pinned: true, project: 'App' },
    { id: 'n', title: 'Not pinned', state: 'idle', pinned: false, project: 'App' },
    { id: 'q', title: 'Also pinned', state: 'running', pinned: true, project: null },
  ];
  assert.deepEqual(
    groupChats(pinnedChats, '').projects.map((x: any) => [x.name, x.chats.map((c: any) => c.id)]),
    [
      ['App', ['p', 'n']],
      ['No project', ['q']],
    ],
  );
});
