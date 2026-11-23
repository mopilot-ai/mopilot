// New chat is never a dead send: on a Host with no folder Start opens the Folder sheet and keeps the text, a folder used before is offered again, and every reason Start is grey is said on screen.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { click, flush } from './support/phone/component-kit';
import { scripted, fakeMedia, menus } from './support/phone/m3';
import { mount, has, button, chip, tap, typeIn, row, PROMPT } from './support/phone/newchat-kit';

const foldersMemory = '../mobile/src/remote/lastFolders';
const { forgetFolders, lastFolder, rememberFolder } = await import(foldersMemory);
beforeEach(() => forgetFolders());

const SNAP = { phase: 'online', generation: 1, selectedPair: 'p', pairs: [{ pairId: 'p', macId: 'm', name: 'Studio Mac' }], presence: {} };
const MACHINES = {
  machines: [
    { id: 'local', name: 'Studio Mac', status: 'online', line: 'This Mac', tone: 'ok', agents: [] },
    {
      id: 'h1',
      name: 'mac-mini-test',
      status: 'online',
      line: 'Online · direct',
      tone: 'ok',
      agents: [{ id: 'codex', label: 'Codex', state: 'ready', via: 'key' }],
    },
  ],
};
const FOLDERS = (p: any) =>
  p.path
    ? { path: p.path, roots: [], entries: [{ name: 'app', path: `${p.path}/app`, git: true }], more: false }
    : { path: null, roots: ['/home/du/code'], entries: [], more: false };
function host(extra: (m: string, p: any) => unknown = () => undefined) {
  const made = scripted((m, p) => {
    const given = extra(m, p);
    if (given !== undefined) return given;
    if (m === 'machine.hello') return { ...menus.hello, capabilities: { ...menus.hello.capabilities, machines: true } };
    if (m === 'machines.list') return MACHINES;
    if (m === 'machines.folders') return FOLDERS(p);
    if (m === 'chat.start') return { chatId: 'codex:new' };
    return undefined;
  });
  made.runtime.onEvent = () => () => undefined;
  return made;
}
const input = () => document.querySelector<HTMLInputElement>(`input[placeholder="${PROMPT}"]`)!;
const starts = (calls: any[]) => calls.filter((c) => c[0] === 'chat.start').map((c) => c[1]);

async function onHost(extra?: (m: string, p: any) => unknown) {
  const { runtime, calls } = host(extra);
  const screen = await mount(runtime, fakeMedia().media, {}, SNAP);
  await flush();
  await tap(chip(screen.host, 'Computer'));
  await row('mac-mini-test');
  return { ...screen, calls };
}

test('Start on a Host with no folder is not dead: it opens the Folder sheet, keeps the text, and the folder picked starts the chat', async () => {
  const { host: page, calls, opened } = await onHost();
  await typeIn('测试');
  const startButton = button(page, 'Start chat')!;
  assert.equal(startButton.disabled, false, 'there is something to press');
  await tap(startButton);
  has(page, /Folder/, 'the Folder sheet is open');
  assert.equal(input().value, '测试', 'the text stays');
  assert.deepEqual(starts(calls), [], 'nothing started yet');
  await row('code');
  await tap(button(document.body, 'Use this folder')!);
  await flush();
  assert.equal(starts(calls).length, 1, 'the folder picked sends it');
  assert.equal(starts(calls)[0].folder, '/home/du/code');
  assert.equal(starts(calls)[0].hostId, 'h1');
  assert.deepEqual(opened, ['codex:new']);
});

test('closing the Folder sheet without a folder sends nothing, and the text is still there', async () => {
  const { host: page, calls } = await onHost();
  await typeIn('later');
  await tap(button(page, 'Start chat')!);
  await click('Close');
  assert.deepEqual(starts(calls), []);
  assert.equal(input().value, 'later');
  // asking again later, with a folder this time, is a plain send
  await tap(chip(page, 'Folder'));
  await row('code');
  await tap(button(document.body, 'Use this folder')!);
  await flush();
  assert.equal(starts(calls).length, 0, 'a folder chosen with no Start pressed does not start by itself');
});

test('the folder a chat last used on a machine is offered again, and the missing folder reads as missing', async () => {
  const first = await onHost();
  assert.match(chip(first.host, 'Folder').textContent!, /Choose a folder/);
  await tap(chip(first.host, 'Folder'));
  await row('code');
  await tap(button(document.body, 'Use this folder')!);
  await typeIn('hello');
  await tap(button(first.host, 'Start chat')!);
  assert.equal(starts(first.calls).length, 1);
  // a new New chat on that machine starts with it
  const { runtime } = host();
  const again = await mount(runtime, fakeMedia().media, {}, SNAP);
  await flush();
  await tap(chip(again.host, 'Computer'));
  await row('mac-mini-test');
  assert.match(chip(again.host, 'Folder').textContent!, /code/);
  // another machine's folder is not carried over
  await tap(chip(again.host, 'Computer'));
  await row('Studio Mac');
  assert.equal(chip(again.host, 'Folder'), undefined);
});

test('every reason Start is grey is said: no folder, no permission the phone may use', async () => {
  const closed = await onHost((m, p) =>
    m === 'options.get'
      ? {
          ...menus.options(p.harness),
          permission: { value: 'plan', rows: [{ id: 'default', label: 'Ask', disabled: 'Closed on your Mac' }] },
        }
      : undefined,
  );
  await typeIn('hello');
  has(closed.host, /permission/i, 'a chat with no permission the phone may use says so');
  assert.equal(button(closed.host, 'Start chat')!.disabled, true);
});

test('the remembered folders are kept per pair and machine, also with no pair connected, and forgotten together', () => {
  rememberFolder('p1', 'h1', '/a');
  rememberFolder(null, 'h1', '/none');
  assert.equal(lastFolder('p1', 'h1'), '/a');
  assert.equal(lastFolder(null, 'h1'), '/none', 'a phone with no pair selected has its own');
  assert.equal(lastFolder('p2', 'h1'), null, 'another pair does not share it');
  assert.equal(lastFolder('p1', 'h2'), null, 'nor another machine');
  forgetFolders();
  assert.equal(lastFolder('p1', 'h1'), null);
  assert.equal(lastFolder(null, 'h1'), null);
});

test('a folder picked after Start does not send a message that was emptied meanwhile', async () => {
  const { host: page, calls } = await onHost();
  await typeIn('draft');
  await tap(button(page, 'Start chat')!);
  has(page, /Folder/, 'the Folder sheet is open');
  await typeIn('');
  await row('code');
  await tap(button(document.body, 'Use this folder')!);
  await flush();
  assert.deepEqual(starts(calls), [], 'there is nothing to send any more');
  assert.equal(button(page, 'Start chat')!.disabled, true);
});
