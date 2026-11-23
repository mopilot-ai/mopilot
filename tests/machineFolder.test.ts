// A folder on a machine named so it never reads as a folder of this Mac, and the words a control that stays here says for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { folderOnMachine, machineFolderKey, machineFolderOf, onMachineHint } from '../src/lib/machineFolder.ts';
import { groupKey } from '../src/lib/projectGroupOrder.ts';

test('a machine folder key carries the machine and the path, and reads back as both', () => {
  const key = machineFolderKey('m1', '/srv/app');
  assert.notEqual(key, '/srv/app');
  assert.deepEqual(machineFolderOf(key), { machineId: 'm1', path: '/srv/app' });
  // a path of its own that holds a separator later still splits at the first one: the machine id never holds one
  assert.deepEqual(machineFolderOf(machineFolderKey('m1', '/a\0b')), { machineId: 'm1', path: '/a\0b' });
});

test('this Mac (no machine id) keeps the plain path, and a plain path is no machine key', () => {
  assert.equal(machineFolderKey('', '/work/app'), '/work/app');
  assert.equal(machineFolderOf('/work/app'), null);
  assert.equal(machineFolderOf(''), null);
  // a leading separator is no machine either
  assert.equal(machineFolderOf('\0/x'), null);
});

test('two machines, and this Mac, with the same path are three keys', () => {
  const keys = new Set([machineFolderKey('m1', '/srv/app'), machineFolderKey('m2', '/srv/app'), machineFolderKey('', '/srv/app')]);
  assert.equal(keys.size, 3);
});

test('a group is ordered, pinned and folded by its project id, else by its folder with its machine', () => {
  assert.equal(groupKey({ id: 'p1', path: '/work/app' }), 'p1');
  assert.equal(groupKey({ id: null, path: '/work/app' }), '/work/app');
  assert.equal(groupKey({ id: null, path: '/work/app', machine: { id: 'm1' } }), machineFolderKey('m1', '/work/app'));
});

test('the words say where the folder is', () => {
  assert.equal(onMachineHint('Studio'), 'On Studio');
  assert.equal(folderOnMachine('Studio'), 'This folder is on Studio, not on this Mac');
});
