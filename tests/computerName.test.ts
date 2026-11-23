// The computer name a phone shows: whatever a Mac reports, made a short single line, or nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanComputerName } from '../shared/remote/computerName.mjs';

test('a reported host name becomes a short single-line name', () => {
  assert.equal(cleanComputerName('Du’s MacBook Pro'), 'Du’s MacBook Pro');
  assert.equal(cleanComputerName('Studio-Mac.local'), 'Studio-Mac');
  assert.equal(cleanComputerName('  Studio\n\tMac  '), 'Studio Mac');
  assert.equal(cleanComputerName('a'.repeat(200))?.length, 64);
  assert.equal(cleanComputerName(`${'b'.repeat(63)} c`), 'b'.repeat(63), 'a cut name does not end in a space');
});

test('characters that draw nothing or reorder the text around them are removed, and a cut never splits a character', () => {
  const bidi = String.fromCharCode(0x202e);
  assert.equal(cleanComputerName(`Mac${bidi}evil`), 'Mac evil');
  assert.equal(cleanComputerName(`a${String.fromCharCode(0x200b)}b${String.fromCharCode(0x2066)}x`), 'a b x');
  assert.equal(cleanComputerName(bidi), null);
  assert.equal(cleanComputerName(String.fromCharCode(0x200b, 0xfeff)), null);
  const emoji = String.fromCodePoint(0x1f600);
  assert.equal(cleanComputerName('x'.repeat(63) + emoji), 'x'.repeat(63) + emoji);
  assert.equal(cleanComputerName('x'.repeat(64) + emoji), 'x'.repeat(64));
  assert.equal(cleanComputerName('Mac.LOCAL '), 'Mac');
});

test('anything that is not a usable name is nothing', () => {
  for (const value of [undefined, null, 7, {}, '', '   ', '\u0000\u0007', '.local']) assert.equal(cleanComputerName(value), null);
});

test('a hello with no computer selected is ignored: nothing is observed or saved, and a selected one is observed', async () => {
  const { createComputerHello } = await import('../mobile/src/remote/computerHello.ts');
  const observed: string[] = [];
  const identities: any = { observe: (pairId: string) => observed.push(pairId) };
  const owner = (selectedPair: string | null) => () => ({
    generation: 1,
    selectedPair,
    vault: { updatePair: async () => true },
    updatePairs: async () => undefined,
  });
  for (const selectedPair of [null, '']) createComputerHello(identities, owner(selectedPair))(Promise.resolve({ name: 'Studio' }));
  assert.deepEqual(observed, []);
  createComputerHello(identities, owner('p1'))(Promise.resolve({ name: 'Studio' }));
  assert.deepEqual(observed, ['p1']);
});
