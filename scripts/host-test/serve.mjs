#!/usr/bin/env node
// TEST ONLY: the Host with a scripted brain, for the journeys that run MoMo on a Host without a real account (the VM rig, tests/momoEvals). It starts the same Host as `mopilot-host serve` (host/src/cli.mjs `main`) and hands MoMo's home two things the shipped entry never does: it gives the Host a quirks table in which the scripted agent can be kept apart from the coding side and asks for no sign-in (`quirks`), and it runs a seeds module once the home is served (`--seeds <file>`, default export `(home, { env }) => void`). The scripted agent is tests/fixtures/fake-acp-agent.mjs, defined in this Host's own harnesses.json as `scripted` (its turns are the fixture's words: TOOL, PERMIT, RATELIMITED, REFUSE…).
// It is not part of the shipped Host and nothing the shipped Host reaches imports it (tests/hostTestBrain.invariant.test.ts), so a release cannot enable any of it.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { main } from '../../host/src/cli.mjs';

const require = createRequire(import.meta.url);
const harnessQuirks = require('../../electron/harness/quirks/index.cjs');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The scripted agent's id: MoMo's brain is `acp:scripted`. */
export const SCRIPTED = 'scripted';

/**
 * The quirks of an agent as this Host sees them (the one table the ACP host, the sign-in probe and MoMo's own checks all read): the scripted agent has the
 * isolation a real agent's quirks give (its process and mode pinned, no tools of its own to turn off) and counts as asking for no sign-in; any other agent has its own.
 * @param {string} id
 */
export function quirks(id) {
  if (id !== SCRIPTED) return harnessQuirks.quirks(id);
  const modes = { currentModeId: 'read-only', availableModes: [{ id: 'read-only', name: 'Read only' }] };
  return {
    id,
    label: 'Scripted',
    args: [path.join(ROOT, 'tests', 'fixtures', 'fake-acp-agent.mjs')],
    env: { FAKE_ACP_PROFILE: JSON.stringify({ modes }) },
    privacyDefaults: [],
    admission: { handshakeTimeoutMs: 10_000 },
    isolation: { env: () => ({}), mode: { mode: 'read-only' } },
  };
}

/** Takes `--seeds <file>` out of the arguments: what the Host is started with, and the seeds module's path. @param {string[]} argv */
export function splitArgs(argv) {
  const rest = [...argv];
  const at = rest.indexOf('--seeds');
  if (at < 0) return { rest, seeds: null };
  const seeds = rest[at + 1];
  if (!seeds || seeds.startsWith('--')) throw new Error('--seeds needs the path of a module.');
  rest.splice(at, 2);
  return { rest, seeds };
}

/** The data folder the Host is started with (`--data-dir <dir>`), or none. @param {string[]} argv */
export const dataDirOf = (argv) => {
  const at = argv.indexOf('--data-dir');
  return at >= 0 ? argv[at + 1] : undefined;
};

/** Defines the scripted agent in the Host's harnesses.json, beside whatever it already has. @param {string} dataDir */
export function defineScriptedAgent(dataDir) {
  const file = path.join(dataDir, 'harnesses.json');
  fs.mkdirSync(dataDir, { recursive: true });
  /** @type {Record<string, unknown>} */
  let found = {};
  try {
    found = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (/** @type {any} */ (error)?.code !== 'ENOENT') throw error;
  }
  found[SCRIPTED] = { label: 'Scripted', bin: process.execPath, args: [path.join(ROOT, 'tests', 'fixtures', 'fake-acp-agent.mjs')] };
  fs.writeFileSync(file, `${JSON.stringify(found, null, 2)}\n`);
}

/** @param {string[]} argv @param {NodeJS.ProcessEnv} env @param {typeof main} run the Host's own entry (a test passes a recorder) */
export async function start(argv, env = process.env, run = main) {
  const { rest, seeds } = splitArgs(argv);
  const dataDir = dataDirOf(rest);
  if (dataDir) defineScriptedAgent(dataDir);
  const seeding = seeds ? (await import(pathToFileURL(path.resolve(seeds)).href)).default : null;
  return run(rest, {
    stdin: process.stdin,
    env,
    momoOverrides: { quirks, ready: seeding ? (/** @type {any} */ home) => seeding(home, { env }) : undefined },
  });
}

/** Run as a script: when this file is the one node was started with, start the Host with the command line, and stop the process a moment after it returns. @param {string | undefined} argv1 @param {string} here this module's url @param {string[]} args @param {{ run?: typeof start, exit?: () => void, env?: NodeJS.ProcessEnv }} [o] */
export async function runAsScript(argv1, here, args, { run = start, exit = process.exit.bind(process), env = process.env } = {}) {
  if (!argv1 || path.resolve(argv1) !== fileURLToPath(here)) return false;
  process.exitCode = await run(args, env);
  setTimeout(exit, 5000).unref();
  return true;
}

await runAsScript(process.argv[1], import.meta.url, process.argv.slice(2));
