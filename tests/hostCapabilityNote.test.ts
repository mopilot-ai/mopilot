// The machine menu's capability limit (2.9): built from the Host's declared capabilities, naming no harness, silent when nothing is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilityNote } from '../shared/host/capabilityNote.mjs';
import { capabilitiesOf, CAPABILITY_KEYS, parseParams } from '../shared/host/schema.mjs';

test('browser and computer use: nothing to say', () => assert.equal(capabilityNote({ iab: true, desktop: true }), ''));
test('a desktop-less Host: only the missing surface', () => assert.equal(capabilityNote({ iab: true, desktop: false }), 'No computer use'));
test('a Host that only has this Mac’s computer use (cu) has no desktop of its own', () =>
  assert.equal(capabilityNote({ iab: true, cu: true }), 'No computer use'));
test('neither: both unavailable', () => assert.equal(capabilityNote({}), 'No browser or computer use'));
test('computer use without a browser', () => assert.equal(capabilityNote({ desktop: true }), 'No browser'));

test('hello capabilities: only true counts; keys outside the five are dropped; missing means absent', () => {
  assert.deepEqual(capabilitiesOf({ iab: true, cu: 'yes', extra: true }), {
    iab: true,
    cu: false,
    desktop: false,
    bu: false,
    shell: false,
  });
  assert.deepEqual(capabilitiesOf(null), { iab: false, cu: false, desktop: false, bu: false, shell: false });
  assert.deepEqual(CAPABILITY_KEYS, ['iab', 'cu', 'desktop', 'bu', 'shell']);
  const hello = parseParams('host.hello', { protocol: { minor: 2, floor: 1 }, capabilities: { iab: true } });
  assert.deepEqual(hello.capabilities, { iab: true, cu: false, desktop: false, bu: false, shell: false });
});
