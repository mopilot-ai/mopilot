// The owner's rules and the spend counter made together (host/src/ownerRules.mjs): a raised limit frees the held chats, and the counter publishes through what is attached.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createOwnerRules } from '../host/src/ownerRules.mjs';
// @ts-ignore: plain ESM without declarations
import { parseOwnerPolicy } from '../shared/host/policy.mjs';

const bad = (m: string) => new Error(m);
const M = 1_000_000;

test('before anything is attached the counter works alone; attached, it publishes and a raised limit drains the held chat', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-rules-'));
  const { policy, spend, attach } = createOwnerRules({ dataDir: dir, report: () => undefined });
  const doc = (chatUsd: number) => parseOwnerPolicy({ version: 1, spend: { chatUsd } }, bad);
  policy.set(doc(5));
  spend.record('c1', { model: 'claude-sonnet-4-5', inputTokens: M, outputTokens: M });
  assert.throws(() => spend.check('c1'), /limit/i);
  const states: unknown[] = [];
  const drained: string[] = [];
  let holdBy: ((id: string) => boolean) | null = null;
  attach({ protocol: { chatState: (id: string, patch: unknown) => states.push([id, patch]) } });
  attach({ sessions: { drainChat: (id: string) => drained.push(id), holdBy: (fn: (id: string) => boolean) => (holdBy = fn) } });
  assert.equal(holdBy!('c1'), true);
  spend.record('c2', { model: 'claude-sonnet-4-5', inputTokens: 1, outputTokens: 1 });
  assert.equal(states.length > 0, true);
  policy.set(doc(500));
  assert.deepEqual(drained, ['c1']);
});
