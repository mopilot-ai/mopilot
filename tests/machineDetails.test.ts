// A machine's Details (src/components/pages/settings/MachineDetails.tsx): where this Mac reaches it, its system, the version of its Host and when it last answered, each only when the machine said it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { machineDetails } from '../src/components/pages/settings/MachineDetails.tsx';

const row: any = { status: 'online', address: 'me@box', platform: 'linux', hostVersion: '1.4.0', lastSeen: 1_000_000 };

test('an online machine lists host, system, version and a last seen of just now', () => {
  assert.deepEqual(machineDetails(row, 5_000_000), [
    { label: 'Host', value: 'me@box' },
    { label: 'System', value: 'Linux' },
    { label: 'Version', value: '1.4.0' },
    { label: 'Last seen', value: 'Just now' },
  ]);
});

test('an offline machine says when it last answered; a field the machine never told is left out', () => {
  const offline = machineDetails({ ...row, status: 'offline', platform: 'darwin' }, 1_000_000 + 2 * 3_600_000);
  assert.equal(offline.find((f) => f.label === 'Last seen')?.value, '2 h ago');
  assert.equal(offline.find((f) => f.label === 'System')?.value, 'macOS');
  const bare = machineDetails({ ...row, status: 'offline', address: '', platform: '', hostVersion: '', lastSeen: null }, 0);
  assert.deepEqual(bare, []);
});

test('a machine that never said where it is reached or its version lists neither', () => {
  const quiet: any = { name: 'box', status: 'offline', platform: 'linux', lastSeen: 1_000_000 };
  assert.deepEqual(
    machineDetails(quiet, 1_000_000 + 60_000).map((f) => f.label),
    ['System', 'Last seen'],
  );
});
