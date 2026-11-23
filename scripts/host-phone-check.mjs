#!/usr/bin/env node
// The one-command check of the phone-direct path (Remote Run P6): runs tests/hostPhoneEndToEnd.test.ts, which starts a Host process, kills the app, has a fake agent raise a card, has a fake phone answer through a local relay and prints each step's time. For a `mopilot-*` VM (the coordinator's acceptance pass), never a user's Mac: `node scripts/host-phone-check.mjs`.
import { spawnSync as realSpawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SLOTS = path.join(import.meta.dirname, 'test-slots.mjs');
const SCENARIO = path.join(import.meta.dirname, '..', 'tests', 'hostPhoneEndToEnd.test.ts');

/**
 * Runs the scenario's test through the shared worker budget and returns the exit code, whatever shard the calling run is on; `argv[0]` names another test file (the script's own test).
 * @param {{ argv?: string[], spawnSync?: typeof realSpawn }} [o]
 */
export function hostPhoneCheck({ argv = [], spawnSync = realSpawn } = {}) {
  // the one file is this command's whole run: a shard of the outer CI run (UNIT_TEST_SHARD=2/3) would leave it on no shard, and node would exit 0 without running it
  const { UNIT_TEST_SHARD, ...env } = process.env;
  return spawnSync(process.execPath, [SLOTS, '--test', argv[0] ?? SCENARIO], { stdio: 'inherit', env }).status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exit(hostPhoneCheck({ argv: process.argv.slice(2) }));
