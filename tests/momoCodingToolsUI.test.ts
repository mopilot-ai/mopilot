// The coding-side MCP servers in Settings › MoMo › Sources (src/components/momo/CodingToolsSection.tsx, McpServerCard.tsx, #2999 C0), the real components over a fake window.native.momoMcp: nothing while there are none; a server off with Allow; allowed with its tools, each with the server's own claim and a switch, New for a tool listed since; starting; didn't start with Retry; Remove behind Details; a failure under the card; the list failing with Retry, no encryption, and only the newest answer shown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';

const React = await import('react');
const { act, createElement } = React;
const { createRoot } = await import('react-dom/client');

const f: any = { calls: [], listeners: new Set() };
const ok = (x: object = {}) => ({ ok: true, ...x });
const rec =
  (name: string) =>
  async (...args: any[]) => (f.calls.push([name, ...args]), f.answers[name]?.(...args) ?? ok());
installNativeStub({
  momoMcp: {
    list: rec('list'),
    allow: rec('allow'),
    remove: rec('remove'),
    setTool: rec('setTool'),
    onChanged: (cb: () => void) => (f.listeners.add(cb), () => f.listeners.delete(cb)),
  },
});
const { CodingToolsSection } = await import('../src/components/momo/CodingToolsSection.tsx');

const tools = [
  { key: 'notes_list#a', name: 'notes_list', description: 'List.', readOnly: true, on: true, isNew: false, blocked: null },
  { key: 'notes_add#b', name: 'notes_add', description: 'Add.', readOnly: false, on: false, isNew: true, blocked: null },
  {
    key: 'odd#c',
    name: 'odd',
    description: 'Odd.',
    readOnly: true,
    on: false,
    isNew: false,
    blocked: 'its inputs have names MoMo does not take',
  },
];
const srv = (o: object = {}) => ({
  key: 'claude:notes',
  name: 'notes',
  from: 'Claude Code',
  transport: 'stdio',
  allowed: false,
  status: 'off',
  error: null,
  tools: [],
  ...o,
});
const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
async function mount() {
  const host = window.document.createElement('div');
  window.document.body.appendChild(host as any);
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(CodingToolsSection)));
  await flush();
  const all = (sel: string, e: any = host) => [...e.querySelectorAll(sel)];
  const card = () => host.querySelector('section[aria-label="notes"]') as any;
  const button = (label: string) => all('button', host).find((b: any) => b.textContent.trim() === label);
  const click = async (el: any) => {
    await act(async () => el.click());
    await flush();
  };
  return {
    host,
    card,
    button,
    click,
    all,
    status: () => card().querySelector('[data-status]').textContent.trim(),
    chips: () => all('.hp-badge', card()).map((b: any) => b.textContent.trim()),
    alerts: () => all('[role="alert"]').map((a: any) => a.textContent),
    changed: async () => {
      await act(async () => f.listeners.forEach((cb: any) => cb()));
      await flush();
    },
    close: () => act(async () => root.unmount()),
  };
}

test('none configured: nothing shows', async () => {
  f.calls = [];
  f.answers = { list: async () => ok({ servers: [], available: true }) };
  const v = await mount();
  assert.equal(v.host.textContent, '');
  await v.close();
});

test('a server through its states: Allow, starting, allowed with its tools and switches, failed with Retry, Remove', async () => {
  let row: any = srv();
  f.calls = [];
  f.answers = { list: async () => ok({ servers: [row], available: true }) };
  const v = await mount();
  assert.equal(v.status(), 'Let MoMo use its tools. Only tools that say they only read start on.');
  assert.deepEqual(v.chips(), []);
  assert.match(v.card().querySelector('dl').textContent, /Claude Code.*On this Mac, apart from your coding chats\..*its own word/);
  await v.click(v.button('Allow'));
  assert.deepEqual(
    f.calls.find((c: any) => c[0] === 'allow'),
    ['allow', 'claude:notes'],
  );
  row = srv({ allowed: true, status: 'starting' });
  await v.changed();
  assert.equal(v.status(), 'Starting…');
  row = srv({ allowed: true, status: 'ready', tools });
  await v.changed();
  assert.equal(v.status(), 'MoMo can use 1 of its 3 tools.');
  assert.deepEqual(v.chips(), ['Allowed', 'New']);
  const items = v.all('li', v.card()).map((li: any) => li.textContent.replace(/\s+/g, ' ').trim());
  assert.deepEqual(items, [
    'notes_list says it only reads',
    'notes_addNew asks each time',
    'odd not offered: its inputs have names MoMo does not take',
  ]);
  const boxes = v.all('input[type="checkbox"]', v.card());
  assert.deepEqual(
    boxes.map((b: any) => b.checked),
    [true, false, false],
  );
  assert.equal(boxes[2].disabled, true);
  await v.click(boxes[1]);
  assert.deepEqual(
    f.calls.find((c: any) => c[0] === 'setTool'),
    ['setTool', 'claude:notes', 'notes_add#b', true],
  );
  await v.click(v.button('Remove from MoMo'));
  assert.deepEqual(
    f.calls.find((c: any) => c[0] === 'remove'),
    ['remove', 'claude:notes'],
  );
  row = srv({ allowed: true, status: 'failed', error: 'spawn x ENOENT' });
  await v.changed();
  assert.equal(v.status(), "It didn't start: spawn x ENOENT");
  assert.deepEqual(v.chips(), ["Didn't start"]);
  await v.click(v.button('Retry'));
  assert.equal(f.calls.filter((c: any) => c[0] === 'allow').length, 2);
  row = srv({ allowed: true, status: 'failed', transport: 'http' });
  await v.changed();
  assert.equal(v.status(), "It didn't start: no reason given");
  assert.match(v.card().querySelector('dl').textContent, /On the web/);
  row = srv({ allowed: true, status: 'off' });
  await v.changed();
  assert.equal(v.status(), 'Allowed. It starts when MoMo needs it.');
  await v.close();
});

test('failures: one under the card, a thrown one too', async () => {
  f.calls = [];
  f.answers = { list: async () => ok({ servers: [srv()], available: true }), allow: async () => ({ ok: false, error: 'spawn failed' }) };
  const v = await mount();
  await v.click(v.button('Allow'));
  assert.deepEqual(v.alerts(), ['spawn failed']);
  f.answers.allow = async () => {
    throw new Error('bridge gone');
  };
  await v.click(v.button('Allow'));
  assert.match(v.alerts()[0], /bridge gone/);
  await v.close();
});

test('the list: a failure with Retry, a throw, no encryption, and only the newest answer shown', async () => {
  f.calls = [];
  f.answers = { list: async () => ({ ok: false, error: 'MoMo is not available' }) };
  const v = await mount();
  assert.match(v.alerts()[0], /Couldn't load coding tools: MoMo is not available/);
  f.answers.list = async () => ok({ servers: [srv()], available: true });
  await v.click(v.button('Retry'));
  assert.ok(v.card());
  f.answers.list = async () => {
    throw new Error('ipc down');
  };
  await v.changed();
  assert.match(v.alerts()[0], /ipc down/);
  f.answers.list = async () => ok({ servers: [], available: false });
  await v.changed();
  assert.match(v.host.textContent, /needs encryption, which isn't available/);
  const gates: ((x: any) => void)[] = [];
  f.answers.list = () => new Promise((r) => gates.push(r));
  await v.changed();
  await v.changed();
  gates[1](ok({ servers: [srv()], available: true }));
  await flush();
  gates[0](ok({ servers: [], available: false }));
  await flush();
  assert.ok(v.card());
  const throws: ((e: any) => void)[] = [];
  f.answers.list = () => new Promise((_r, j) => throws.push(j));
  await v.changed();
  f.answers.list = async () => ok({ servers: [srv()], available: true });
  await v.changed();
  throws[0](new Error('late'));
  await flush();
  assert.deepEqual(v.alerts(), []);
  await v.close();
});
