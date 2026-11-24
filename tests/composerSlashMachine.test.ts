// The / menu of a chat on a machine (#4915): what the agent there lists (its commands and skills, from the Host), for a chat that exists and for the new chat a machine is picked for, with one row that says why when the machine cannot list.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { commandEntry } from '../shared/host/hostCommandsWire.mjs';
import { $, $$, mouse } from './support/composer-kit.ts';
import { fx, mountComposer, reset, settle, store } from './support/composer-setup.ts';
beforeEach(() => reset());
const rows = () => $$('.slash-panel .add-panel-item');
const titles = () => rows().map((x) => x.querySelector('.add-panel-title')!.textContent);
const row = (title: string) => rows().find((x) => x.querySelector('.add-panel-title')!.textContent === title)!;
const text = (title: string, part: string) => row(title).querySelector(`.add-panel-${part}`)?.textContent;

const box = { id: 'box', name: 'box' };
const compact = { name: 'compact', description: 'Summarize the conversation', hint: '[focus]', kind: 'command', insert: '/compact ' };
const deploy = { name: 'deploy-notes', description: 'A skill of the project', kind: 'skill', insert: '/deploy-notes ' };
const review = { name: 'review', description: 'Review the repo', kind: 'skill', insert: '$review ' };
const ready = (...commands: object[]) => ({ machine: box, answer: { state: 'ready', listed: true, commands } });

async function openMenu(threadId: string | null) {
  const m = await mountComposer({ threadId });
  await m.type('/');
  return m;
}

test('a chat on a machine lists what its agent offers there, says where from, and a row puts its text in the message', async () => {
  store.set({ basicOf: { c1: 'host-claude' } });
  fx.location = { machine: 'box', pending: false };
  fx.machineCommands = ready(compact, deploy, review);
  const m = await openMenu('c1');
  try {
    for (const t of ['/compact', '/deploy-notes', 'review']) assert.ok(titles().includes(t), t);
    assert.equal(text('/compact', 'desc'), 'Summarize the conversation [focus]');
    assert.match(row('/compact').textContent ?? '', /on box/);
    await mouse(row('review'), 'mousedown');
    await settle();
    assert.equal(m.text, '$review ');
  } finally {
    await m.unmount();
  }
});

test('an inline skill from a machine replaces only the query and keeps the caret next to the skill', async () => {
  store.set({ basicOf: { c1: 'host-claude' } });
  fx.location = { machine: 'box', pending: false };
  fx.machineCommands = ready(deploy);
  const m = await mountComposer({ threadId: 'c1' });
  try {
    await m.type('Use /dep for this change', 'Use /dep'.length);
    await mouse(row('/deploy-notes'), 'mousedown');
    await settle();
    assert.equal(m.text, 'Use /deploy-notes for this change');
    assert.equal(m.editor().selectionStart, 'Use /deploy-notes '.length);
  } finally {
    await m.unmount();
  }
});

test('a restored machine command shows its hint without opening the picker', async () => {
  store.set({ basicOf: { c1: 'host-claude' }, drafts: { c1: { text: '/équipe/révision ', attachments: [] } } });
  fx.location = { machine: 'box', pending: false };
  const command = commandEntry({ name: 'équipe/révision', description: 'Review a project', hint: '<topic>' });
  assert.ok(command);
  const requests = new Set<boolean | 'draft'>();
  fx.machineCommands = (threadId: string | null, wanted: boolean | 'draft') => {
    if (threadId === 'c1' && wanted) requests.add(wanted);
    return requests.size ? ready(command) : { machine: box, answer: { state: 'loading' } };
  };
  const m = await mountComposer({ threadId: 'c1' });
  try {
    assert.deepEqual([...requests], ['draft']);
    assert.equal($('.slash-panel'), null);
    assert.equal(m.text, '/équipe/révision ');
    assert.equal(m.editor().dataset.commandHint, '<topic>');
    await m.type('/');
    assert.ok(titles().includes('/équipe/révision'));
    assert.deepEqual([...requests], ['draft', true]);
  } finally {
    await m.unmount();
  }
});

test('a chat on a machine has no disabled Skills row when the machine lists, and keeps it (with its reason) when it cannot', async () => {
  store.set({ basicOf: { c1: 'host-claude' } });
  fx.location = { machine: 'box', pending: false };
  fx.attachmentTarget = { why: 'Only images can be attached to a chat on box.', read: () => ({ key: 'k', blocked: true }) };
  fx.machineCommands = ready(compact);
  let m = await openMenu('c1');
  try {
    assert.ok(!titles().includes('Skills'));
  } finally {
    await m.unmount();
  }
  // the machine is not known yet: the menu is this chat's own, as before
  fx.machineCommands = null;
  m = await openMenu('c1');
  try {
    assert.ok(titles().includes('Skills'));
    assert.equal(row('Skills').getAttribute('aria-disabled'), 'true');
  } finally {
    await m.unmount();
  }
});

test('a name the menu already has is not listed twice', async () => {
  store.set({ basicOf: { c1: 'host-claude' } });
  fx.location = { machine: 'box', pending: false };
  fx.acpRegistry = { menu: [{ name: 'compact', description: 'The app’s own', dispatch: 'ui' }] };
  fx.machineCommands = ready(compact, deploy);
  const m = await openMenu('c1');
  try {
    assert.equal(titles().filter((t) => t === '/compact').length, 1);
    assert.equal(text('/compact', 'desc'), 'The app’s own');
    assert.ok(titles().includes('/deploy-notes'));
  } finally {
    await m.unmount();
  }
});

test('the new chat a machine is picked for lists the machine’s commands, not this Mac’s', async () => {
  fx.location = { machine: 'box', pending: false };
  // a name this Mac's own menu has too (/new) is still the machine's row there: the machine's agent runs it
  fx.machineCommands = ready(compact, review, { name: 'new', description: 'The agent’s own', kind: 'command', insert: '/new ' });
  const m = await openMenu(null);
  try {
    assert.deepEqual(titles(), ['/compact', 'review', '/new']);
    await mouse(row('/compact'), 'mousedown');
    await settle();
    assert.equal(m.text, '/compact ');
  } finally {
    await m.unmount();
  }
});

test('a menu the machine cannot fill says why in one row: reading, an older Host, a machine that cannot be reached', async () => {
  fx.location = { machine: 'box', pending: false };
  const cases: [object, RegExp][] = [
    [{ state: 'loading' }, /Reading box/],
    [{ state: 'outdated' }, /Update Host on box to list its commands/],
    [{ state: 'unavailable', notice: 'Could not reach that machine.' }, /Could not reach that machine/],
  ];
  for (const [answer, words] of cases) {
    fx.machineCommands = { machine: box, answer };
    const m = await openMenu(null);
    try {
      assert.deepEqual(titles(), ['Commands']);
      assert.equal(row('Commands').getAttribute('aria-disabled'), 'true');
      assert.match(text('Commands', 'desc') ?? '', words);
    } finally {
      await m.unmount();
    }
  }
  fx.machineCommands = { machine: box, answer: null };
  const m = await openMenu(null);
  try {
    assert.match(text('Commands', 'desc') ?? '', /Reading box/);
  } finally {
    await m.unmount();
  }
});

const unlisted = { machine: box, answer: { state: 'ready', listed: false, commands: [] } };
const acpMenu = {
  menu: [
    { name: 'new', description: 'Start a new chat', dispatch: 'ui' },
    { name: 'plan', description: 'Switch the agent into plan mode', dispatch: 'passthrough' },
  ],
};

test('a chat on a machine with an agent the Host cannot list keeps its own menu: the agent’s commands from its session, no row for the machine, and the Skills row with its reason', async () => {
  store.set({ basicOf: { c1: 'kimi' } });
  fx.location = { machine: 'box', pending: false };
  fx.attachmentTarget = { why: 'Only images can be attached to a chat on box.', read: () => ({ key: 'k', blocked: true }) };
  fx.acpRegistry = acpMenu;
  fx.machineCommands = unlisted;
  const m = await openMenu('c1');
  try {
    assert.deepEqual(titles(), ['/new', '/plan', 'Skills']);
    assert.ok(rows().every((x) => !x.querySelector('.add-panel-scope')?.textContent?.startsWith('on ')));
    assert.equal(row('Skills').getAttribute('aria-disabled'), 'true');
    // a row sends what the agent takes: its own command as text, never a command of the machine's other agents
    await mouse(row('/plan'), 'mousedown');
    await settle();
    assert.equal(m.text, '/plan ');
  } finally {
    await m.unmount();
  }
});

test('the new chat a machine is picked for with an agent the Host cannot list says nothing is listed yet, and offers no row of this Mac’s', async () => {
  fx.location = { machine: 'box', pending: false };
  fx.machineCommands = unlisted;
  const m = await openMenu(null);
  try {
    assert.deepEqual(titles(), ['Commands']);
    assert.equal(row('Commands').getAttribute('aria-disabled'), 'true');
    assert.equal(text('Commands', 'desc'), 'No commands listed yet.');
  } finally {
    await m.unmount();
  }
});
