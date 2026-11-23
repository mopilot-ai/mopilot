// The test serve entry (scripts/host-test/serve.mjs) hands the Host its code-only overrides, and the Host uses them: the scripted quirks reach the harness options, and `ready` gets MoMo's home once it exists. (The shipped Host takes neither: tests/hostTestBrain.invariant.test.ts.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { defineScriptedAgent, quirks, runAsScript, start } from '../scripts/host-test/serve.mjs';
// @ts-ignore
import { main } from '../host/src/cli.mjs';
import { waitFor } from './support/waitFor.ts';

const scratch = (t: any) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('the serve entry passes the scripted quirks, and the seeds module as the ready hook only when one is named', async (t) => {
  const dir = scratch(t);
  const seeds = path.join(dir, 'seeds.mjs');
  fs.writeFileSync(seeds, 'export default (home, o) => { globalThis.__seeded = [home, o.env.MARK]; };\n');
  t.after(() => void delete (globalThis as any).__seeded);
  const seen: any[] = [];
  const run: any = async (argv: string[], io: any) => (seen.push({ argv, io }), 0);
  assert.equal(await start(['serve', '--data-dir', path.join(dir, 'data'), '--seeds', seeds], { MARK: 'm1' }, run), 0);
  assert.deepEqual(seen[0].argv, ['serve', '--data-dir', path.join(dir, 'data')]);
  assert.equal(seen[0].io.momoOverrides.quirks, quirks);
  const home = { id: 'home' };
  await seen[0].io.momoOverrides.ready(home);
  assert.deepEqual((globalThis as any).__seeded, [home, 'm1']);
  await start(['serve'], {}, run);
  assert.equal(seen[1].io.momoOverrides.ready, undefined, 'no seeds, no hook');
});

test('the Host takes the overrides: its quirks are the table it reads, and ready runs with MoMo’s home before it serves', async (t) => {
  const dir = scratch(t);
  const signals = new EventEmitter() as unknown as NodeJS.Process;
  const ready: any[] = [];
  const done = main(['serve', '--data-dir', dir], {
    env: { MOPILOT_HOST_ROOTS: dir },
    signals,
    out: () => undefined,
    err: () => undefined,
    momoOverrides: { quirks, ready: (home: any) => void ready.push(home) },
  });
  await waitFor(() => ready.length > 0, 'the ready hook');
  assert.equal(typeof ready[0].stamp, 'function', 'it is MoMo’s home');
  signals.emit('SIGTERM');
  await done;
});

test('the scripted agent’s isolation, a registry file that cannot be read, and running as a script', async (t) => {
  assert.deepEqual(quirks('scripted').isolation.env(), {});
  assert.equal(quirks('scripted').isolation.mode.mode, 'read-only');
  // a harness file that is not JSON is an error to see, never silently replaced
  const dir = scratch(t);
  fs.writeFileSync(path.join(dir, 'harnesses.json'), '{ not json');
  assert.throws(() => defineScriptedAgent(dir), SyntaxError);
  // run as a script only when this file is the one node started
  const ran: unknown[] = [];
  const exits: number[] = [];
  const here = new URL('../scripts/host-test/serve.mjs', import.meta.url).href;
  const run: any = async (args: string[]) => (ran.push(args), 7);
  const was = process.exitCode;
  t.after(() => void (process.exitCode = was));
  assert.equal(await runAsScript(undefined, here, ['x'], { run, exit: () => void exits.push(1) }), false);
  assert.equal(await runAsScript('/elsewhere.mjs', here, ['x'], { run }), false);
  assert.deepEqual(ran, []);
  assert.equal(await runAsScript(new URL(here).pathname, here, ['serve'], { run, exit: () => void exits.push(1) }), true);
  assert.deepEqual(ran, [['serve']]);
  assert.equal(process.exitCode, 7);
});
