import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveSitePermission } from '../src/lib/browserPermissions.ts';

test('Settings publishes saved site access and removals after IPC succeeds', async () => {
  const origin = 'https://example.test';
  const changes: any[] = [];
  for (const level of ['read', 'write', null] as const) {
    const sites = level ? [{ origin, level }] : [];
    const success = await saveSitePermission(
      {
        setSite: async (o, l) => {
          assert.equal(o, origin);
          assert.equal(l, level);
          assert.deepEqual(changes, []);
          return sites;
        },
      },
      origin,
      level,
      (next) => changes.push(next),
      () => assert.fail('must not report an error'),
    );
    assert.equal(success, true);
    assert.deepEqual(changes.pop(), sites);
  }
});

test('Settings keeps its displayed sites and reports failed edits or removals', async () => {
  const messages: string[] = [];
  for (const level of ['read', null] as const) {
    const success = await saveSitePermission(
      {
        setSite: async () => {
          throw new Error('disk full');
        },
      },
      'https://example.test',
      level,
      () => assert.fail('must not publish an unsaved change'),
      (message) => messages.push(message),
    );

    assert.equal(success, false);
  }
  assert.deepEqual(messages, [
    "Couldn't save the site permission. Please try again.",
    "Couldn't save the site permission. Please try again.",
  ]);
});
