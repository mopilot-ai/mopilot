// The shell of a chat on a machine (src/lib/machineShell.ts, audit turn:T63): ssh into the chat's folder there for a machine added over ssh, none for one reached another way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import {
  shellMachineOf,
  terminalMachineOf,
  machineShellTab,
  remoteShellCommand,
  shellWhere,
  sshTargetOf,
} from '../src/lib/machineShell.ts';

const BOX = { id: 'ssh:me@box', name: 'box', folder: "/srv/it's app" };

test('A: only a machine added over ssh has a target; one added by command or in the cloud has none', () => {
  assert.equal(sshTargetOf('ssh:me@box'), 'me@box');
  assert.equal(sshTargetOf('relay:abc'), null);
  assert.equal(sshTargetOf('cloud:x'), null);
});

test('B: the remote shell goes into the chat’s folder, quoted for a name with a quote, and stays in the login shell; no folder, no cd', () => {
  assert.equal(remoteShellCommand("/srv/it's app"), `cd '/srv/it'\\''s app' && exec "$SHELL" -l`);
  assert.equal(remoteShellCommand('/srv/app'), `cd '/srv/app' && exec "$SHELL" -l`);
  assert.equal(remoteShellCommand(''), 'exec "$SHELL" -l');
});

test('C: the tab is titled with the machine, starts ssh from this Mac’s home, and names where it runs; Windows uses ssh.exe', () => {
  const tab = machineShellTab(BOX, '/Users/me', false)!;
  assert.equal(tab.title, 'box');
  assert.equal(tab.cwd, '/Users/me');
  assert.deepEqual(tab.command, ['/usr/bin/ssh', '-t', 'me@box', remoteShellCommand("/srv/it's app")]);
  assert.equal(tab.where, shellWhere(BOX));
  assert.match(tab.id, /^term-/);
  assert.equal(machineShellTab(BOX, 'C:\\Users\\me', true)!.command![0], 'ssh.exe');
  assert.notEqual(shellWhere(BOX), shellWhere({ ...BOX, folder: '/other' }), 'another folder on the machine is another shell');
});

test('C2: a machine added with a port is -p, not a host name with a colon (siblings of the add channel)', () => {
  const tab = machineShellTab({ ...BOX, id: 'ssh:me@box:2222' }, '/Users/me', false)!;
  assert.deepEqual(tab.command!.slice(0, 5), ['/usr/bin/ssh', '-t', '-p', '2222', 'me@box']);
});

test('D: a machine with no ssh from this Mac has no tab', () => {
  assert.equal(machineShellTab({ id: 'relay:abc', name: 'far', folder: '/x' }, '/Users/me'), null);
});

test('E: the chat’s machine carries the chat’s folder there, none for a chat on this Mac, and an empty folder when the chat has none', () => {
  assert.deepEqual(shellMachineOf({ id: 'ssh:me@box', name: 'box' }, '/srv/app'), { id: 'ssh:me@box', name: 'box', folder: '/srv/app' });
  assert.deepEqual(shellMachineOf({ id: 'ssh:me@box', name: 'box' }, undefined), { id: 'ssh:me@box', name: 'box', folder: '' });
  assert.equal(shellMachineOf(null, '/repo'), null);
});

test('F: the bottom terminal is on the focused chat’s machine, else on the machine the new-chat draft picked, else on this Mac', () => {
  const chat = { id: 'ssh:me@box', name: 'box' };
  const draft = { id: 'ssh:me@far', name: 'far', path: '/srv/draft' };
  // a chat wins over the draft, and carries its own folder
  assert.deepEqual(terminalMachineOf(true, chat, '/srv/app', draft), { id: 'ssh:me@box', name: 'box', folder: '/srv/app' });
  // a chat on this Mac stays on this Mac whatever the draft picked
  assert.equal(terminalMachineOf(true, null, '/repo', draft), null);
  // no chat: the draft's machine and folder (empty while none is picked: ssh with no cd)
  assert.deepEqual(terminalMachineOf(false, null, undefined, draft), { id: 'ssh:me@far', name: 'far', folder: '/srv/draft' });
  const bare = machineShellTab(terminalMachineOf(false, null, undefined, { ...draft, path: '' })!, '/Users/me', false)!;
  assert.deepEqual(bare.command, ['/usr/bin/ssh', '-t', 'me@far', 'exec "$SHELL" -l']);
  // no chat and no draft machine: this Mac
  assert.equal(terminalMachineOf(false, null, undefined, null), null);
  // a draft machine with no ssh has no tab, so the panel says so instead of opening a local shell
  assert.equal(machineShellTab(terminalMachineOf(false, null, undefined, { id: 'relay:x', name: 'x', path: '' })!, '/Users/me'), null);
});
