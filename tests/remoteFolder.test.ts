// A chat's folder on a machine as the string links carry (src/lib/remoteFolder.ts, #4062): never looked up on this Mac, opened in the pane through the machine's Host, and read by `useLinkCwd` from the context a chat on a machine is drawn in.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h } from 'react';
import { render } from './support/shell-panels-kit.ts';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';

const toasts: unknown[][] = [];
const tabs: unknown[][] = [];
mock.module('../src/store/core.ts', {
  namedExports: {
    useStore: { getState: () => ({ prefs: {} }) },
    toast: (...a: unknown[]) => toasts.push(a),
    toastFailure: () => () => undefined,
  },
});
mock.module('../src/store/panes.ts', { namedExports: { openPaneTab: (...a: unknown[]) => tabs.push(a) } });
const fake = fakeNative({ fs: { messagePath: async () => ({ path: '/local', kind: 'file' }) } });
installNative(fake);
const { RemoteFolderContext, parseRemoteCwd, remoteCwd, remotePathOf, useLinkCwd } = await import('../src/lib/remoteFolder.ts');
const { lookupMessagePath, useMessagePath, resetMessagePaths } = await import('../src/lib/messagePaths.ts');
const { openMessagePath, openMessageLink } = await import('../src/session/open.ts');

test('a machine’s folder travels as one string and is read back; any other string is this Mac’s', () => {
  const at = remoteCwd('ssh:me@box', '/srv/my app');
  assert.deepEqual(parseRemoteCwd(at), { machineId: 'ssh:me@box', folder: '/srv/my app' });
  for (const own of ['/Users/me/app', '', null, undefined, 'host:no-newline']) assert.equal(parseRemoteCwd(own), null);
});

test('a path on the machine is taken from its folder, with . and .. resolved; ~ cannot be said', () => {
  assert.equal(remotePathOf('src/a.ts', '/srv/app'), '/srv/app/src/a.ts');
  assert.equal(remotePathOf('./src/../lib//b.ts', '/srv/app/'), '/srv/app/lib/b.ts');
  assert.equal(remotePathOf('/etc/hosts', '/srv/app'), '/etc/hosts');
  assert.equal(remotePathOf('../../../..', '/srv/app'), '/');
  assert.equal(remotePathOf('~/notes.md', '/srv/app'), null);
  assert.equal(remotePathOf('~', '/srv/app'), null);
});

test('links read the context: this Mac’s folder by default, the machine’s marker inside a chat on a machine', async () => {
  const seen: unknown[] = [];
  const Probe = () => (seen.push(useLinkCwd('/Users/me/app')), null);
  let v = await render(h(Probe));
  await v.unmount();
  v = await render(h(RemoteFolderContext.Provider, { value: { machineId: 'm', folder: '/srv/app' } }, h(Probe)));
  await v.unmount();
  assert.deepEqual(seen, ['/Users/me/app', remoteCwd('m', '/srv/app')]);
});

test('a path in a chat on a machine is not looked up on this Mac: no request, no answer, no link', async () => {
  resetMessagePaths();
  const at = remoteCwd('m', '/srv/app');
  assert.equal(await lookupMessagePath('src/a.ts', at), null);
  let found: unknown = 'unset';
  const Probe = () => ((found = useMessagePath('src/a.ts', at)), null);
  const v = await render(h(Probe));
  await v.unmount();
  assert.equal(found, null);
  assert.equal(fake.callsTo('fs.messagePath').length, 0, 'main was never asked');
  // this Mac's own folder still asks
  assert.deepEqual(await lookupMessagePath('src/a.ts', '/Users/me/app'), { path: '/local', kind: 'file' });
  assert.equal(fake.callsTo('fs.messagePath').length, 1);
});

test('opening a path in a chat on a machine opens it in the pane from the machine; Cmd-click and ~ say it is elsewhere', async () => {
  const at = remoteCwd('m', '/srv/app');
  await openMessagePath('src/a.ts', at, { line: 3, endLine: 5 });
  assert.deepEqual(tabs.at(-1), ['file', { path: '/srv/app/src/a.ts', line: 3, endLine: 5, cwd: at, title: 'a.ts' }]);
  openMessageLink('/srv/other/b.md', at);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(tabs.at(-1), ['file', { path: '/srv/other/b.md', line: undefined, endLine: undefined, cwd: at, title: 'b.md' }]);
  const before = tabs.length;
  await openMessagePath('src/a.ts', at, {}, true);
  await openMessagePath('~/notes.md', at);
  assert.equal(tabs.length, before, 'nothing opened here');
  assert.deepEqual(toasts.slice(-2), [
    ['That file is on another machine. It opens in the app.', 'error'],
    ['That file is on another machine. It opens in the app.', 'error'],
  ]);
  assert.equal(fake.callsTo('fs.messagePath').length, 1, 'only this Mac’s own earlier lookup');
});

test('while the chat’s machine is not known a link opens nothing, here or there', async () => {
  const before = tabs.length;
  await openMessagePath('src/a.ts', remoteCwd('', '/srv/app'));
  assert.equal(tabs.length, before);
  assert.deepEqual(toasts.at(-1), ['Still checking where this chat runs. Try again in a moment.', 'error']);
});
