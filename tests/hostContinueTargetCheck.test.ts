// The agent check before a carry (electron/host/continueTargetCheck.cjs, #4910): it asks only a Host that can refuse, and never refuses what the Host would take.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assertTargetTakes } = require('../electron/host/continueTargetCheck.cjs');

const FAMILIES = ['continueFamilies'];
const seen = (result: object, features: string[] = FAMILIES) => {
  const asked: string[] = [];
  return { asked, status: async (id: string) => (asked.push(id), { result, features }) };
};

test('I: this Mac and a harness no one spells are never asked about: the Mac starts every family, and the Host decides the rest', async () => {
  const mac = seen({});
  await assertTargetTakes({ hostId: 'local', harness: 'claude', status: mac.status });
  const odd = seen({});
  await assertTargetTakes({ hostId: 'B', harness: 'not-a-harness', status: odd.status });
  assert.deepEqual([...mac.asked, ...odd.asked], []);
});

test('A: an agent the Host lists as ready passes, a status without agents passes, and the chat that lives on a Host is read as its own agent', async () => {
  const ok = seen({ harnesses: [{ id: 'claude', detected: true, signedIn: true }] });
  await assertTargetTakes({ hostId: 'B', harness: 'acp:host-claude:chat-1', status: ok.status });
  assert.deepEqual(ok.asked, ['B']);
  await assertTargetTakes({ hostId: 'B', harness: 'codex', status: seen({}).status });
  const gone = seen({ harnesses: [{ id: 'claude', detected: false, signedIn: false }] });
  await assert.rejects(assertTargetTakes({ hostId: 'B', harness: 'acp:host-claude:chat-1', status: gone.status }), {
    code: 'agent_missing',
  });
});
