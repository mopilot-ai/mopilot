// How the phone reaches each machine (mobile/src/remote/reach.ts) and the words of direct access (shared/host/directWords.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reachOf, reachLabel, canSetUpDirect, lineFor } from '../mobile/src/remote/reach';
import {
  reachWord,
  removeLine,
  downLine,
  setupLine,
  answeredLine,
  cardLine,
  pausesLine,
  DIRECT_ACTIONS,
} from '../shared/host/directWords.mjs';

test('the reach: its own enrollment wins, then the Mac while it lists the machine and is up, else neither', () => {
  assert.equal(reachOf({ enrolled: true, listedByMac: false, macOnline: false }), 'direct');
  assert.equal(reachOf({ enrolled: false, listedByMac: true, macOnline: true }), 'through');
  assert.equal(reachOf({ enrolled: false, listedByMac: true, macOnline: false }), 'none');
  assert.equal(reachOf({ enrolled: false, listedByMac: false, macOnline: true }), 'none');
});

test('the reach word and the machine line: Direct, Through <Mac>, none; the Host’s own line once direct', () => {
  assert.deepEqual(
    [reachLabel('direct', 'Work Mac'), reachLabel('through', 'Work Mac'), reachLabel('none', 'Work Mac')],
    ['Direct', 'Through Work Mac', null],
  );
  assert.equal(reachWord('through', 'M'), 'Through M');
  assert.equal(lineFor({ reach: 'direct', macLine: 'Online', hostLine: '2 waiting' }), '2 waiting');
  assert.equal(lineFor({ reach: 'direct', macLine: 'Online', hostLine: null }), 'Online');
  assert.equal(lineFor({ reach: 'through', macLine: 'Online', hostLine: '2 waiting' }), 'Online');
});

test('direct access is offered only through the Mac, and not while it is being set up', () => {
  assert.equal(canSetUpDirect({ reach: 'through', setup: 'idle' }), true);
  assert.equal(canSetUpDirect({ reach: 'through', setup: 'failed' }), true);
  assert.equal(canSetUpDirect({ reach: 'through', setup: 'working' }), false);
  assert.equal(canSetUpDirect({ reach: 'direct', setup: 'idle' }), false);
  assert.equal(canSetUpDirect({ reach: 'none', setup: 'idle' }), false);
});

test('the words of the plan: setup lines, answers by device, closed states and the pause countdown', () => {
  assert.deepEqual(DIRECT_ACTIONS, {
    start: 'Use without your Mac',
    retry: 'Try again',
    repair: 'Reconnect',
    remove: 'Remove this machine',
    confirmRemove: 'Remove',
    keep: 'Keep',
  });
  assert.equal(
    removeLine('Studio'),
    'Remove Studio from this phone? Its chats and approvals stop showing here until you set it up again from your Mac.',
  );
  assert.equal(
    downLine('Studio', true),
    'Studio is not linked to the relay: approvals cannot reach this phone. Reconnect to set it up again.',
  );
  assert.equal(downLine('Studio', false), 'Studio does not answer.');
  assert.equal(reachWord('direct', 'M', true), 'Not reachable directly');
  assert.equal(reachWord('direct', 'M', false), 'Direct');
  assert.equal(reachWord('through', 'M', true), 'Through M', 'only an enrollment can be down');
  assert.equal(reachLabel('direct', 'M', true), 'Not reachable directly');
  assert.deepEqual(
    [setupLine('working', 'build-box'), setupLine('failed', 'build-box'), setupLine('update', 'build-box')],
    ['Setting up…', "Couldn't set up direct access to build-box.", 'Update build-box.'],
  );
  assert.deepEqual(
    [
      answeredLine('allow', null),
      answeredLine('deny', 'Work MacBook Pro'),
      answeredLine('other', null),
      answeredLine('allow', 'Pocket iPhone'),
    ],
    ['Allowed', 'Denied on Work MacBook Pro', 'Answered', 'Allowed on Pocket iPhone'],
  );
  assert.deepEqual(
    [
      cardLine('lost', { device: 'Work MacBook Pro' }),
      cardLine('lost'),
      cardLine('expired'),
      cardLine('cancelled'),
      cardLine('restarted'),
      cardLine('moved'),
      cardLine('unreachable', { machine: 'build-box' }),
      cardLine('no-path', { machine: 'build-box' }),
      cardLine('managed', { org: 'Acme' }),
      cardLine('unreachable'),
    ],
    [
      'Already answered on Work MacBook Pro.',
      'Already answered.',
      'Not answered',
      'Cancelled',
      'The machine restarted',
      'This chat moved to another machine.',
      "Couldn't reach build-box.",
      "Can't reach build-box.",
      'Managed by Acme',
      "Couldn't reach the machine.",
    ],
  );
  assert.deepEqual([pausesLine(24), pausesLine(0)], ['Pauses in 24 min', null]);
});
