// What a continue to a Host says on the wire once the Host takes every family (#4906): the feature a Host declares for it, the refusals by fact and their copy. A: the feature and the codes; I: an older Host does not offer the feature and a continue's refusals are ones the ledger lets be retried.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTINUE_CODES, CONTINUE_FAMILIES_FEATURE, CONTINUE_REFUSAL_COPY } from '../shared/host/continue.mjs';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEpochStore } from '../host/src/epochs.mjs';
import { createGuard } from '../host/src/guard.mjs';
import { createLedger } from '../host/src/ledger.mjs';
import { createProtocol } from '../host/src/protocol.mjs';
import { FEATURES, helloParams } from '../shared/host/schema.mjs';

test('A: the Host declares the feature that says it takes a continue for every family, and the refusals name the fact that holds', () => {
  assert.equal(CONTINUE_FAMILIES_FEATURE, 'continueFamilies');
  assert.ok(FEATURES.includes(CONTINUE_FAMILIES_FEATURE));
  assert.ok(helloParams().features.includes(CONTINUE_FAMILIES_FEATURE));
  assert.equal(CONTINUE_CODES.agentMissing, 'agent_missing');
  assert.equal(CONTINUE_CODES.agentSignedOut, 'agent_signed_out');
  // one sentence per fact, the machine's name and the agent's filled by the app
  assert.deepEqual(Object.keys(CONTINUE_REFUSAL_COPY).sort(), ['agent_missing', 'agent_signed_out', 'harness_not_configured']);
  assert.equal(new Set(Object.values(CONTINUE_REFUSAL_COPY)).size, 3);
  assert.match(CONTINUE_REFUSAL_COPY.agent_missing, /\{agent\}.*\{machine\}/);
  assert.match(CONTINUE_REFUSAL_COPY.agent_signed_out, /\{agent\}.*\{machine\}/);
  assert.match(CONTINUE_REFUSAL_COPY.harness_not_configured, /\{machine\}.*too old/);
});

test('I: a Host that takes ACP agents only does not offer the feature, the other options still work, and nothing else is dropped', () => {
  const all = helloParams().features;
  const aco = helloParams({ continueFamilies: false }).features;
  assert.deepEqual(
    all.filter((f: string) => !aco.includes(f)),
    [CONTINUE_FAMILIES_FEATURE],
  );
  const both = helloParams({ switching: false, continueFamilies: false }).features;
  assert.equal(all.length - both.length, 2);
});

/** A Host's answer to hello with a continue Host that does (or does not) say it takes every family. */
async function helloOf(continueHost?: object) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-cfam-'));
  const quiet = { report: () => undefined };
  const host: any = new EventEmitter();
  host.cancel = () => undefined;
  const runtime: any = { host, send: async () => ({ turnId: 't' }), permit: () => true, familyOf: () => 'acp' };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const options: any = { runtime, epochs, guard, status: () => ({ running: true }), ...(continueHost ? { continueHost } : {}) };
  const conn = createProtocol(options).connection(() => undefined);
  return (await conn.call('host.hello', helloParams())).agreed.features as string[];
}

test('A: a Host offers the feature only when its continue side says it takes every family; one that takes ACP only, or none, does not', async () => {
  assert.ok((await helloOf({ takesFamilies: true })).includes(CONTINUE_FAMILIES_FEATURE));
  assert.equal((await helloOf({})).includes(CONTINUE_FAMILIES_FEATURE), false);
  assert.equal((await helloOf()).includes(CONTINUE_FAMILIES_FEATURE), false);
});
