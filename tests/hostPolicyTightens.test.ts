// The owner layer can only be stricter than the managed one (host/src/policy.mjs, plan W2 tests A1, A2 and W1): rewriting the file while the owner layer changes, in either order, settles on the stricter value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { createPolicy } from '../host/src/policy.mjs';
// @ts-ignore: plain ESM without declarations
import { createManagedFile } from '../host/src/managedPolicyFile.mjs';

const owner = (permissionMax: string) => ({ version: 1, permissionMax, approvals: { remindMinutes: 10, pauseMinutes: 30 }, notify: {} });
const world = (max: string) => {
  const state = { content: JSON.stringify({ version: 1, permission: { max } }) };
  const fs: any = { statSync: () => ({ uid: 0, mode: 0o100644 }), readFileSync: () => state.content };
  const file = createManagedFile({ platform: 'linux', fs });
  return { state, file, policy: createPolicy({ managedFile: file }) };
};
const ceiling = (p: any) => p.effective().doc.permissionMax;

test('W1: the owner raises their ceiling while the file is rewritten; the effective value is the stricter, in both orders', () => {
  for (const order of ['owner first', 'file first']) {
    const w = world('auto-review');
    const edit = () => w.policy.set(owner('full-access'));
    const rewrite = () => ((w.state.content = JSON.stringify({ version: 1, permission: { max: 'default' } })), w.file.reload());
    if (order === 'owner first') edit(), rewrite();
    else rewrite(), edit();
    assert.equal(ceiling(w.policy), 'default');
  }
});

test('A1/A2: two reads of the file settle on the later content whichever finishes first, and an owner value below it stays', () => {
  const w = world('full-access');
  w.policy.set(owner('read-only'));
  w.state.content = JSON.stringify({ version: 1, permission: { max: 'default' } });
  w.file.reload();
  w.state.content = JSON.stringify({ version: 1, permission: { max: 'auto-review' } });
  w.file.reload();
  assert.equal(ceiling(w.policy), 'read-only');
  w.policy.set(owner('full-access'));
  assert.equal(ceiling(w.policy), 'auto-review');
});

test('removing the file frees the owner layer; a corrupt file never does', () => {
  const w = world('default');
  w.policy.set(owner('full-access'));
  assert.equal(ceiling(w.policy), 'default');
  w.state.content = '{ nope';
  w.file.reload();
  assert.equal(ceiling(w.policy), 'default');
});
