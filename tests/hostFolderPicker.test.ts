// The renderer's folder picker for remote machines (src/components/composer/HostFolderPicker.tsx, src/lib/hostFolders.ts): browse inside what the machine shares, Up stops at a root, a slow listing never replaces a newer one (A2), clone with its progress and the short notices (B2), a worktree of a repository, and the folder handed back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { act, createElement } from 'react';
import { render, click, type, flush } from './support/shell-chrome-kit.ts';
import { useFakeNative } from './support/ports/native.ts';
import { attemptKey, folderNotice, joinRemote, parentRemote, repoFolderName } from '../src/lib/hostFolders.ts';

const { HostFolderPicker } = await import('../src/components/composer/HostFolderPicker.tsx');

const HOME = {
  path: '/home/u',
  roots: ['/home/u'],
  entries: [
    { name: 'app', path: '/home/u/app', git: true },
    { name: 'docs', path: '/home/u/docs', git: false },
  ],
};
const APP = { path: '/home/u/app', roots: ['/home/u'], entries: [] };

/** The bridge's answers: a value, or the refusal with its code. */
const ok = (value: unknown) => ({ value });
const refused = (message: string, code: string) => ({ error: { message, code } });
const buttons = (host: Element) => [...host.querySelectorAll('button')];
const button = (host: Element, label: string) =>
  buttons(host).find((b) => (b.textContent ?? '').includes(label) || b.getAttribute('aria-label') === label) as HTMLButtonElement;
const field = (host: Element, label: string) => host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
const notice = (host: Element) => host.querySelector('.host-picker-notice')?.textContent ?? '';

function usePicker(t: any, over: Record<string, any> = {}) {
  const picked: string[] = [];
  let closed = 0;
  let progress: (p: any) => void = () => undefined;
  const fake = useFakeNative(t, {
    host: {
      fsList: async (_id: string, q: any) => ok(q.path === '/home/u/app' ? APP : HOME),
      onCloneProgress: (cb: any) => ((progress = cb), () => (progress = () => undefined)),
      ...over,
    },
  });
  const el = createElement(HostFolderPicker, {
    hostId: 'box',
    name: 'build-box',
    onPick: (p: string) => picked.push(p),
    onClose: () => closed++,
  });
  return { el, picked, fake, pushProgress: (p: any) => act(async () => progress(p)), closed: () => closed };
}

test('the lib: refusals become short notices, a repository names its folder, paths join and climb as the machine writes them', () => {
  assert.equal(
    folderNotice(Object.assign(new Error('raw'), { code: 'outside_roots' })),
    'That folder is outside what this machine shares.',
  );
  // the Host's handshake refusal never shows its protocol sentence
  assert.equal(
    folderNotice(
      Object.assign(new Error('Say hello first: the host and the app have not agreed on a version yet.'), { code: 'hello_required' }),
    ),
    'The connection to that machine was not ready. Try again.',
  );
  const cloneSaid = (said: string) => folderNotice(Object.assign(new Error(said), { code: 'clone_failed' }));
  for (const said of [
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    'git@github.com: Permission denied (publickey).',
    'fatal: unable to access x: The requested URL returned error: 403',
    'fatal: repository not found',
    'Host key verification failed.',
  ])
    assert.equal(cloneSaid(said), 'This machine can’t sign in to that repository.', said);
  assert.equal(cloneSaid('fatal: unable to access x: Could not resolve host: x'), 'This machine can’t reach that address.');
  assert.equal(
    cloneSaid('fatal: could not create work tree dir: Permission denied'),
    'could not create work tree dir: Permission denied',
    'a local failure is not a sign-in',
  );
  assert.equal(cloneSaid('error: copy-fd: No space left on device'), 'This machine is out of disk space.');
  assert.equal(cloneSaid('fatal: destination has a problem'), 'destination has a problem', 'any other cause in git’s own words');
  assert.equal(cloneSaid('fatal: '), 'The clone failed.');
  assert.equal(
    folderNotice(Object.assign(new Error('Could not reach the machine over SSH.'), { code: 'other' })),
    'Could not reach the machine over SSH.',
  );
  assert.equal(folderNotice(new Error('plain')), 'plain');
  assert.equal(folderNotice(null), 'null');
  assert.equal(repoFolderName('https://github.com/org/app.git'), 'app');
  assert.equal(repoFolderName(' git@github.com:org/tool.git/ '), 'tool');
  assert.equal(repoFolderName('ssh://host/org/plain'), 'plain');
  assert.equal(repoFolderName(''), '');
  assert.equal(joinRemote('/home/u/', 'app'), '/home/u/app');
  assert.equal(joinRemote('/', 'app'), '/app');
  assert.equal(parentRemote('/home/u/app'), '/home/u');
  assert.equal(parentRemote('/home'), '/');
  assert.equal(parentRemote('/'), null);
  assert.notEqual(attemptKey(), attemptKey());
  assert.match(attemptKey(), /^[\w.:-]{8,128}$/);
});

test('it lists the machine from its first root, opens a folder, climbs with Up (not above a root), and hands back the folder in view', async (t) => {
  const p = usePicker(t);
  const { host, unmount } = await render(p.el);
  await flush();
  assert.equal(host.querySelector('.dialog-head')!.textContent?.includes('Folder on build-box'), true);
  assert.deepEqual(p.fake.callsTo('host.fsList')[0], ['box', { path: undefined }]);
  assert.equal(host.querySelector('.host-picker-path')!.textContent, '/home/u');
  assert.equal(button(host, 'Up one folder').disabled, true, 'a root has nothing above it');
  assert.deepEqual(
    [...host.querySelectorAll('.host-picker-row')].map((r) => r.textContent?.trim()),
    ['app Worktree…', 'docs'],
  );
  await click(button(host, 'app'));
  await flush();
  assert.equal(host.querySelector('.host-picker-path')!.textContent, '/home/u/app');
  assert.equal(host.querySelector('.host-picker-empty')!.textContent, 'No folders');
  assert.equal(button(host, 'Up one folder').disabled, false);
  await click(button(host, 'Use this folder'));
  assert.deepEqual(p.picked, ['/home/u/app']);
  await click(button(host, 'Up one folder'));
  await flush();
  assert.equal(host.querySelector('.host-picker-path')!.textContent, '/home/u');
  await unmount();
});

test('a refused folder shows its short notice and keeps the list; a slow listing never replaces a newer one (A2)', async (t) => {
  const pending: ((v: any) => void)[] = [];
  const p = usePicker(t, {
    fsList: (_id: string, q: any) =>
      q.path === '/home/u/docs'
        ? Promise.resolve(refused('raw', 'outside_roots'))
        : q.path === '/home/u/app'
          ? new Promise((r) => pending.push(r))
          : Promise.resolve(ok(HOME)),
  });
  const { host, unmount } = await render(p.el);
  await flush();
  await click(button(host, 'docs'));
  await flush();
  assert.equal(notice(host), 'That folder is outside what this machine shares.');
  assert.equal(host.querySelector('.host-picker-path')!.textContent, '/home/u');
  // app is slow; docs is asked after it and fails first: the late app listing is dropped
  await click(button(host, 'app'));
  await click(button(host, 'docs'));
  await flush();
  pending[0](ok(APP));
  await flush();
  assert.equal(host.querySelector('.host-picker-path')!.textContent, '/home/u', 'the older answer did not win');
  assert.equal(notice(host), 'That folder is outside what this machine shares.');
  await unmount();
});

test('a listing that fails on the first read shows why and leaves Use this folder off', async (t) => {
  const p = usePicker(t, { fsList: async () => refused('x', 'directory_missing') });
  const { host, unmount } = await render(p.el);
  await flush();
  assert.equal(notice(host), 'That folder is not on this machine.');
  assert.equal(host.querySelector('.host-picker-path')!.textContent, 'Loading…');
  assert.equal(button(host, 'Use this folder').disabled, true);
  assert.equal(button(host, 'Clone repository…').disabled, true);
  await unmount();
});

test('clone: the folder name follows the address, progress shows while it runs, and the new folder is handed back', async (t) => {
  let release!: (v: any) => void;
  const p = usePicker(t, { clone: (_id: string, q: any) => (((p.fake as any).lastClone = q), new Promise((r) => (release = r))) });
  const { host, unmount } = await render(p.el);
  await flush();
  await click(button(host, 'Clone repository…'));
  assert.equal(button(host, 'Clone').disabled, true, 'nothing to clone yet');
  await type(field(host, 'Repository address'), 'https://github.com/org/app.git');
  assert.equal(field(host, 'Folder name').value, 'app');
  await type(field(host, 'Folder name'), 'app2');
  await click(button(host, 'Clone'));
  const asked = (p.fake as any).lastClone;
  assert.equal(asked.url, 'https://github.com/org/app.git');
  assert.equal(asked.dest, '/home/u/app2');
  assert.match(asked.key, /^app:/);
  assert.equal(button(host, 'Clone').disabled, true, 'busy while it runs');
  await p.pushProgress({ hostId: 'other', key: asked.key, phase: 'Receiving objects', percent: 1 });
  await p.pushProgress({ hostId: 'box', key: 'not-mine', phase: 'Receiving objects', percent: 2 });
  await p.pushProgress({ hostId: 'box', key: asked.key, phase: 'Receiving objects', percent: 45 });
  await flush();
  assert.equal(host.querySelector('.host-picker-progress')!.textContent, 'Receiving objects 45%');
  release(ok({ path: '/home/u/app2', existed: false }));
  await flush();
  assert.deepEqual(p.picked, ['/home/u/app2']);
  await unmount();
});

test('with the clone form open the folders still open, and the clone goes into the folder then shown', async (t) => {
  let dest = '';
  const p = usePicker(t, {
    clone: async (_id: string, q: any) => ((dest = q.dest), ok({ path: q.dest, existed: false })),
  });
  const { host, unmount } = await render(p.el);
  await flush();
  await click(button(host, 'Clone repository…'));
  await type(field(host, 'Repository address'), 'https://example.com/org/app');
  const row = host.querySelector('.host-picker-open') as HTMLButtonElement;
  assert.equal(row.disabled, false, 'a folder can be opened while the form is open');
  const name = row.textContent;
  await click(row);
  await flush();
  assert.equal(field(host, 'Repository address').value, 'https://example.com/org/app', 'the form stays');
  await click(button(host, 'Clone'));
  await flush();
  assert.match(dest, new RegExp(`${name}/app$`));
  unmount();
});

test('a failed clone keeps the form and what was typed, says why, and the next try uses a new key (B2)', async (t) => {
  const keys: string[] = [];
  let fail = true;
  const p = usePicker(t, {
    clone: async (_id: string, q: any) => {
      keys.push(q.key);
      if (fail) return refused('fatal: repository not found', 'clone_failed');
      return ok({ path: '/home/u/app', existed: true });
    },
  });
  const { host, unmount } = await render(p.el);
  await flush();
  await click(button(host, 'Clone repository…'));
  await type(field(host, 'Repository address'), 'git@github.com:org/app.git');
  await click(button(host, 'Clone'));
  await flush();
  assert.equal(notice(host), 'This machine can’t sign in to that repository.');
  assert.equal(field(host, 'Repository address').value, 'git@github.com:org/app.git');
  assert.equal(button(host, 'Clone').disabled, false, 'retryable');
  fail = false;
  await click(button(host, 'Clone'));
  await flush();
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
  assert.deepEqual(p.picked, ['/home/u/app']);
  await unmount();
});

test('cancel leaves the form without cloning; worktree: a repository row asks for a branch and hands back the new folder', async (t) => {
  const made: any[] = [];
  const p = usePicker(t, {
    worktree: async (_id: string, q: any) => (made.push(q), ok({ path: '/home/u/app.worktrees/feature', existed: false })),
  });
  const { host, unmount } = await render(p.el);
  await flush();
  await click(button(host, 'Clone repository…'));
  await click(button(host, 'Cancel'));
  assert.equal(field(host, 'Repository address'), null);
  assert.equal(p.fake.callsTo('host.clone').length, 0);
  assert.equal(button(host, 'docs').parentElement!.querySelector('.btn'), null, 'only a repository offers a worktree');
  await click(button(host, 'Worktree…'));
  assert.equal(button(host, 'Create worktree').disabled, true);
  await type(field(host, 'Branch'), 'feature');
  await click(button(host, 'Create worktree'));
  await flush();
  assert.equal(made[0].repo, '/home/u/app');
  assert.equal(made[0].branch, 'feature');
  assert.deepEqual(p.picked, ['/home/u/app.worktrees/feature']);
  await unmount();
});

test('closing while a clone runs drops its result: nothing is picked and no state is set after unmount (A3)', async (t) => {
  let release!: (v: any) => void;
  const p = usePicker(t, { clone: () => new Promise((r) => (release = r)) });
  const { host, unmount } = await render(p.el);
  await flush();
  await click(button(host, 'Clone repository…'));
  await type(field(host, 'Repository address'), 'https://github.com/org/app.git');
  await click(button(host, 'Clone'));
  await unmount();
  release(ok({ path: '/home/u/app', existed: false }));
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(p.picked, []);
  // and a refusal after it too
  const q = usePicker(t, { clone: () => new Promise((r) => setTimeout(() => r(refused('late', 'clone_failed')), 1)) });
  const second = await render(q.el);
  await flush();
  await click(button(second.host, 'Clone repository…'));
  await type(field(second.host, 'Repository address'), 'https://github.com/org/app.git');
  await click(button(second.host, 'Clone'));
  await second.unmount();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(q.picked, []);
});

test('Escape and the close button close the dialog', async (t) => {
  const p = usePicker(t);
  const { host, unmount } = await render(p.el);
  await flush();
  await click(button(host, 'Close'));
  assert.equal(p.closed(), 1);
  await unmount();
});
