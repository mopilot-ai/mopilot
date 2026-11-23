// New chat on a Host: the machine picker in the Mac's words, that machine's agents (with why one can't run), a folder there, no files, account or worktree, and a start the Mac held with its warning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, click, createElement, createRoot, flush } from './support/phone/component-kit';
import { scripted, fakeMedia, menus } from './support/phone/m3';
import { mount, has, button, chip, tap, typeIn, row, attach } from './support/phone/newchat-kit';

const foldersPath = '../mobile/src/remote/folders';
const pickPath = '../mobile/src/remote/useMachinePick';
const { folderChip, loadFolders } = await import(foldersPath);
const { hostAgents } = await import(pickPath);

const SNAP = { phase: 'online', generation: 1, selectedPair: 'p', pairs: [{ pairId: 'p', macId: 'm', name: 'Studio Mac' }], presence: {} };
const MACHINES = {
  machines: [
    { id: 'local', name: 'Studio Mac', status: 'online', line: 'This Mac', tone: 'ok', agents: [] },
    {
      id: 'h1',
      name: 'Build box',
      status: 'online',
      line: 'Online · direct',
      tone: 'ok',
      agents: [
        { id: 'claude', label: 'Claude Code', state: 'signin', via: null },
        { id: 'codex', label: 'Codex', state: 'ready', via: 'key' },
      ],
    },
    {
      id: 'h2',
      name: 'Old box',
      status: 'offline',
      line: 'Offline · last seen yesterday',
      tone: 'off',
      agents: [{ id: 'codex', label: 'Codex', state: 'ready', via: 'own' }],
    },
  ],
};
const FOLDERS = (p: any) =>
  p.path
    ? { path: p.path, roots: [], entries: [{ name: 'app', path: `${p.path}/app`, git: true }], more: false }
    : { path: null, roots: ['/home/du/code'], entries: [], more: true };
function host(extra: (m: string, p: any) => unknown = () => undefined, machines = true) {
  const made = scripted((m, p) => {
    const given = extra(m, p);
    if (given !== undefined) return given;
    if (m === 'machine.hello') return { ...menus.hello, capabilities: { ...menus.hello.capabilities, machines } };
    if (m === 'machines.list') return MACHINES;
    if (m === 'machines.folders') return FOLDERS(p);
    if (m === 'chat.start') return { chatId: 'codex:new' };
    return undefined;
  });
  // the Mac's events reach the screen (machines.changed)
  const listeners = new Set<(e: any) => void>();
  made.runtime.onEvent = (f: (e: any) => void) => (listeners.add(f), () => listeners.delete(f));
  return { ...made, emit: (e: any) => listeners.forEach((f) => f(e)) };
}

test('the folder list and the agents of a Host are read with care', async () => {
  assert.equal(folderChip(null), 'Choose a folder');
  assert.equal(folderChip('/home/du/code/app/'), 'app');
  assert.equal(folderChip('/'), '/');
  assert.deepEqual(
    hostAgents(MACHINES.machines[1] as any).map((a: any) => [a.id, a.detail, !!a.unavailable]),
    [
      ['claude', 'Sign in on your Mac', true],
      ['codex', "Uses your Mac's key · new turns need your Mac online", false],
    ],
  );
  const request = async (_m: string, p: any) =>
    p.path
      ? {
          path: p.path,
          roots: [{ name: 'code', path: '/c' }, 'x', '/'],
          entries: [{ name: 'a', path: '/c/a', git: true }, { path: '/c/b' }, {}],
        }
      : { roots: [], entries: [] };
  const listed = await loadFolders(request as any, 'h1', '/c');
  assert.deepEqual(listed.roots, [
    { name: 'code', path: '/c', git: false },
    { name: 'x', path: 'x', git: false },
    { name: '/', path: '/', git: false },
  ]);
  assert.deepEqual(listed.entries, [
    { name: 'a', path: '/c/a', git: true },
    { name: '/c/b', path: '/c/b', git: false },
  ]);
  assert.equal(listed.more, false);
  assert.deepEqual(await loadFolders(request as any, 'h1', null), { path: null, roots: [], entries: [], more: false });
  await assert.rejects(loadFolders((async () => ({})) as any, 'h1', null), /folders on that machine/);
});

test('a chat on a Host: pick the machine, its ready agent, a folder there; the start carries hostId and folder and nothing of this Mac', async () => {
  const { runtime, calls } = host();
  const { host: page, opened } = await mount(runtime, fakeMedia().media, {}, SNAP);
  await flush();
  await tap(chip(page, 'Computer'));
  has(page, /Run on.*Studio MacThis Mac.*Build boxOnline · direct.*Old boxOffline · last seen yesterday/);
  await row('Build box');
  assert.ok(chip(page, 'Computer').textContent!.includes('Build box'));
  // that machine's agents: the one needing a sign-in is listed with why, not offered; the ready one is picked
  assert.ok(chip(page, 'Agent').textContent!.includes('Codex'));
  await tap(chip(page, 'Agent'));
  has(page, /Claude CodeSign in on your Mac/);
  assert.equal(button(page, 'Claude Code'), undefined);
  await click('Close');
  // Explicit images are available; the Host uses its own folder instead of a local project.
  assert.ok(button(page, 'Add to session'));
  assert.equal(chip(page, 'Project'), undefined);
  assert.ok(chip(page, 'Folder').textContent!.includes('Choose a folder'));
  await typeIn('Fix the build');
  assert.equal(button(page, 'Start chat')!.disabled, false, 'Start is never dead: with no folder it asks for one (phoneNewChatHostFolder)');
  await tap(chip(page, 'Folder'));
  has(page, /code/);
  has(page, /More folders are on the machine/);
  await row('code');
  has(page, /Use this folder\/home\/du\/code/);
  await act(async () => [...document.querySelectorAll<HTMLElement>('button[aria-label="Back"]')].at(-1)!.click());
  await flush();
  await row('code');
  await row('app');
  await click('Use this folder');
  assert.ok(chip(page, 'Folder').textContent!.includes('app'));
  // no account to pick there either
  await click('Model, codex model Low');
  assert.equal(button(page, 'Account, Automatic'), undefined);
  await click('Close');
  await click('Start chat');
  const start = calls.find((c) => c[0] === 'chat.start')![1];
  assert.equal(start.hostId, 'h1');
  assert.equal(start.folder, '/home/du/code/app');
  assert.equal(start.harness, 'codex');
  assert.deepEqual([start.projectId, start.account, start.worktree], [undefined, undefined, undefined]);
  assert.deepEqual(start.attachments, []);
  assert.deepEqual(opened, ['codex:new']);
  assert.deepEqual(
    calls.filter((c) => c[0] === 'machines.folders').map((c) => c[1]),
    [
      { id: 'h1' },
      { id: 'h1', path: '/home/du/code' },
      { id: 'h1' },
      { id: 'h1', path: '/home/du/code' },
      { id: 'h1', path: '/home/du/code/app' },
    ],
  );
});

test('a start the Mac makes with a warning (its permission could not be set there) opens the chat at once with the warning for its page; a refusal shows its message', async () => {
  let refuse = false;
  const { runtime } = host((m) =>
    m === 'chat.start'
      ? refuse
        ? Promise.reject(new Error('Codex is not set up on Old box.'))
        : { chatId: 'codex:held', warning: 'Started, but the permission could not be set on Old box.' }
      : undefined,
  );
  const { host: page, opened, sents, sendings } = await mount(runtime, fakeMedia().media, {}, SNAP);
  await flush();
  await tap(chip(page, 'Computer'));
  await row('Old box');
  await tap(chip(page, 'Folder'));
  await row('code');
  await click('Use this folder');
  await typeIn('Later');
  await click('Start chat');
  // the page opens on the tap; the warning goes with the chat, never holding the person on New chat
  assert.deepEqual(sendings, ['Later']);
  assert.deepEqual(opened, ['codex:held']);
  assert.deepEqual(sents, [
    {
      text: 'Later',
      warning: 'Started, but the permission could not be set on Old box.',
    },
  ]);
  assert.doesNotMatch(page.textContent!, /Started, but the permission/);
  assert.equal(button(page, 'Open chat'), undefined);
  refuse = true;
  const second = await mount(runtime, fakeMedia().media, {}, SNAP);
  await flush();
  await tap(chip(second.host, 'Computer'));
  await row('Old box');
  await tap(chip(second.host, 'Folder'));
  await row('code');
  await click('Use this folder');
  await typeIn('Now');
  await click('Start chat');
  has(second.host, /Codex is not set up on Old box\./);
});

test('back on this Mac its project and files return; a Host that leaves the list puts the pick back on this Mac; a folder that fails to list says why', async () => {
  let failFolders = false;
  const { runtime, emit } = host((m) =>
    m === 'machines.folders' && failFolders ? Promise.reject(new Error('Build box is asleep')) : undefined,
  );
  const { host: page } = await mount(runtime, fakeMedia().media, {}, SNAP);
  await flush();
  await tap(chip(page, 'Computer'));
  await row('Build box');
  await tap(chip(page, 'Computer'));
  await row('Build box');
  assert.ok(chip(page, 'Folder'), 'the same machine again keeps it');
  failFolders = true;
  await tap(chip(page, 'Folder'));
  has(page, /Build box is asleep/);
  await click('Close');
  await tap(chip(page, 'Computer'));
  await row('Studio Mac');
  assert.ok(chip(page, 'Project'));
  assert.ok(button(page, 'Add to session'));
  assert.equal(chip(page, 'Folder'), undefined);
  // the Mac drops the Host: the pick follows
  await tap(chip(page, 'Computer'));
  await row('Build box');
  assert.ok(chip(page, 'Folder'));
  await act(async () => emit({ ev: 'machines.changed', machines: [MACHINES.machines[0], MACHINES.machines[2]] }));
  await flush();
  assert.ok(chip(page, 'Computer').textContent!.includes('Studio Mac'));
  assert.equal(chip(page, 'Folder'), undefined);
  assert.ok(chip(page, 'Project'));
});

test('a Mac without Host access keeps the one-Mac computer sheet and asks for no machines', async () => {
  const { runtime, calls } = host(() => undefined, false);
  const { host: page } = await mount(runtime, fakeMedia().media, {}, SNAP);
  await flush();
  await tap(chip(page, 'Computer'));
  has(page, /Change computers in Settings/);
  assert.equal(
    calls.some((c) => c[0] === 'machines.list'),
    false,
  );
});

test('a machine that is away refuses the start: its message shows, the text stays, and no chat is offered to open', async () => {
  const { runtime } = host((m) =>
    m === 'chat.start' ? Promise.reject(new Error("Old box isn't reachable. Check it's online, then try again.")) : undefined,
  );
  const { host: page, opened, sendings } = await mount(runtime, fakeMedia().media, {}, SNAP);
  await flush();
  await tap(chip(page, 'Computer'));
  await row('Old box');
  await tap(chip(page, 'Folder'));
  await row('code');
  await click('Use this folder');
  await typeIn('Later');
  await click('Start chat');
  has(page, /Old box isn't reachable/);
  assert.deepEqual(sendings, ['Later', null], 'the chat page opened on the tap and the refusal handed the person back to New chat');
  assert.equal(button(page, 'Open chat'), undefined);
  assert.equal(document.querySelector<HTMLInputElement>('input[placeholder="Describe a task or ask a question"]')!.value, 'Later');
  assert.deepEqual(opened, []);
  assert.equal(button(page, 'Start chat')!.disabled, false, 'it can be tried again');
});

for (const [code, message] of [
  ['outside_roots', 'That folder is outside the folders Old box shares.'],
  ['directory_missing', "That folder doesn't exist on Old box any more."],
] as const) {
  test(`a ${code} refusal shows its message the same way: the text stays and no chat is offered to open`, async () => {
    const { runtime } = host((m) => (m === 'chat.start' ? Promise.reject(Object.assign(new Error(message), { code })) : undefined));
    const { host: page, opened } = await mount(runtime, fakeMedia().media, {}, SNAP);
    await flush();
    await tap(chip(page, 'Computer'));
    await row('Old box');
    await tap(chip(page, 'Folder'));
    await row('code');
    await click('Use this folder');
    await typeIn('Keep me');
    await click('Start chat');
    has(page, new RegExp(message.replace(/[.']/g, '.')));
    assert.equal(button(page, 'Open chat'), undefined);
    assert.equal(document.querySelector<HTMLInputElement>('input[placeholder="Describe a task or ask a question"]')!.value, 'Keep me');
    assert.deepEqual(opened, []);
  });
}

test('a Host with no agent ready says so instead of hiding the agent', async () => {
  const none = {
    machines: [
      MACHINES.machines[0],
      { ...MACHINES.machines[1], agents: [{ id: 'claude', label: 'Claude Code', state: 'signin', via: null }] },
    ],
  };
  const { runtime } = host((m) => (m === 'machines.list' ? none : undefined));
  const { host: page } = await mount(runtime, fakeMedia().media, {}, SNAP);
  await flush();
  await tap(chip(page, 'Computer'));
  await row('Build box');
  has(page, /No agent is ready on Build box\./);
  assert.equal(chip(page, 'Agent'), undefined);
});

test('an offline machine with no agent listed says it is offline, not that no agent is ready', async () => {
  const away = {
    machines: [MACHINES.machines[0], { ...MACHINES.machines[2], name: 'Old box', agents: [] }],
  };
  const { runtime } = host((m) => (m === 'machines.list' ? away : undefined));
  const { host: page } = await mount(runtime, fakeMedia().media, {}, SNAP);
  await flush();
  await tap(chip(page, 'Computer'));
  await row('Old box');
  has(page, /Old box is offline\./);
  assert.doesNotMatch(page.textContent!, /No agent is ready on Old box/);
});

test('the state dot is green, amber or grey by the tone the Mac gives', async () => {
  const sheetsPath = '../mobile/src/components/MachineSheets';
  const { ToneDot } = await import(sheetsPath);
  const colors: string[] = [];
  for (const tone of ['ok', 'warn', 'off']) {
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    await act(async () => root.render(createElement(ToneDot, { tone })));
    colors.push(JSON.parse(el.querySelector<HTMLElement>('[data-style]')!.dataset.style!).backgroundColor);
    await act(async () => root.unmount());
    el.remove();
  }
  assert.equal(new Set(colors).size, 3);
});

test('a phone starts an image-only Remote Run with its explicitly uploaded image and local optimistic preview', async () => {
  const { runtime, calls } = host();
  const preview = 'file:///remote-run-picture.jpg';
  const view = await mount(
    runtime,
    fakeMedia({ library: { name: 'picture.jpg', mime: 'image/jpeg', base64: 'QUJD', uri: preview } }).media,
    {},
    SNAP,
  );
  await tap(chip(view.host, 'Computer'));
  await row('Build box');
  await attach('Photo library');
  await flush();
  assert.equal(button(view.host, 'Start chat')!.disabled, false);
  await tap(chip(view.host, 'Folder'));
  await row('code');
  await row('app');
  await click('Use this folder');
  await click('Start chat');
  const request = calls.find(([method]) => method === 'chat.start')![1];
  assert.equal(request.hostId, 'h1');
  assert.equal(request.text, '');
  assert.deepEqual(request.attachments, ['0123456789abcdef']);
  assert.deepEqual((view.sents[0] as any).pictures, [preview]);
});
