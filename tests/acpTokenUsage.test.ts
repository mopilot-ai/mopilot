// A basic (ACP) chat's token usage report (shared/acpTokenUsage.mjs): the context in use from usage_update, the session's tokens added once per prompt, and a fresh count for a new session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AcpTokenUsage } from '../shared/acpTokenUsage.mjs';

const usage = new AcpTokenUsage();
const acpContextUsed = (nid: string, used: number, size?: unknown) => usage.contextUsed(nid, used, size);
const acpTurnUsage = (nid: string, turnId: string | null | undefined, u: unknown) => usage.turnUsage(nid, turnId, u);
const forgetAcpUsage = (nid: string) => usage.forget(nid);

test('no report before the context is known; prompt usage adds once per turn and rides on the next report', () => {
  const nid = 'acp:kimi:a';
  forgetAcpUsage(nid);
  assert.equal(acpTurnUsage(nid, 't0', { inputTokens: 4, outputTokens: 1 }), null);
  const r1 = acpContextUsed(nid, 100, 1000)!;
  assert.equal(r1.last.totalTokens, 100);
  assert.equal(r1.last.inputTokens, 100);
  assert.equal(r1.modelContextWindow, 1000);
  assert.equal(r1.total.totalTokens, 5);
  assert.equal(acpTurnUsage(nid, 't0', { inputTokens: 4 }), null);
  assert.equal(acpTurnUsage(nid, 't1', null), null);
  assert.equal(acpTurnUsage(nid, 't1', { totalTokens: 10 })!.total.totalTokens, 15);
  // a turn without an id is added each time
  assert.equal(acpTurnUsage(nid, undefined, { totalTokens: 1 })!.total.totalTokens, 16);
  assert.equal(acpTurnUsage(nid, null, { totalTokens: 1 })!.total.totalTokens, 17);
  // an unknown or zero size is no window
  assert.equal(acpContextUsed(nid, 120, 0)!.modelContextWindow, null);
  assert.equal(acpContextUsed(nid, 120, 'big')!.modelContextWindow, null);
  forgetAcpUsage(nid);
  assert.equal(acpContextUsed(nid, 7, 10)!.total.totalTokens, 0);
});
