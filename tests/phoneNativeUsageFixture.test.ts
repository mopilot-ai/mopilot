// The native usage journey's fake Mac satisfies the production usage parser and reader before a Xcode build is dispatched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/phone/register.ts';
import { runtime } from './e2e/fixtures/phone-usage-native-fixture';
const clientPath = '../mobile/src/remote/client';
const usagePath = '../mobile/src/remote/usage';
const { ownedRequest } = await import(clientPath);
const { loadUsage, usageLines } = await import(usagePath);

test('native fixture serves accounts, a sign-in state, both reset forms and a changed fresh read', async () => {
  const request = ownedRequest(runtime);
  const first = await loadUsage(request);
  assert.deepEqual(
    first.map((a: any) => [a.harness, a.label, a.active, a.state]),
    [
      ['claude', 'Work', true, 'available'],
      ['codex', 'Personal', false, 'available'],
      ['codex', 'Spare', false, 'signin'],
    ],
  );
  assert.equal(usageLines(first[0].windows[0]).value, '75% left');
  assert.equal(usageLines(first[0].windows[1]).detail, 'Resets Friday 9 AM');
  assert.match(usageLines(first[1].windows[0]).detail, /^Resets /);
  const fresh = await loadUsage(request, true);
  assert.equal(usageLines(fresh[0].windows[0]).value, '65% left');
});
