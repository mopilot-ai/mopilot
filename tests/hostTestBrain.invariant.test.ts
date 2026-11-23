// The scripted brain exists for tests only, and a release cannot enable it: the quirks table the Host reads (and so MoMo's isolation check, the sign-in probe and the ACP host) can be replaced by code alone (never by the environment, a file or an argument), the only code that replaces it is scripts/host-test/serve.mjs, and nothing the shipped Host reaches imports that entry, its seeds or the scripted agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { momoHomeFor, createMomoHidden } from '../host/src/momoWiring.mjs';
// @ts-ignore
// @ts-ignore
import { createNoSignIn } from '../host/src/noSignIn.mjs';
// @ts-ignore
import { defineScriptedAgent, quirks, splitArgs, dataDirOf, SCRIPTED } from '../scripts/host-test/serve.mjs';

const require = createRequire(import.meta.url);
const { hostFiles } = require('../electron/host/bundle.cjs');
const ROOT = path.join(import.meta.dirname, '..');

test('nothing the shipped Host reaches is a test file, the test entry, its seeds or the scripted agent', () => {
  const shipped: string[] = hostFiles(ROOT);
  assert.ok(shipped.length > 50, `walked ${shipped.length} files`);
  assert.ok(shipped.includes('host/src/cli.mjs'));
  for (const file of shipped) {
    assert.ok(!/^(scripts|tests)\//.test(file), `${file} is shipped but is a script or a test`);
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(
      text,
      /(?:from|import\(|require\()\s*['"][^'"]*(?:scripts\/host-test|fake-acp-agent|momoSeeds)[^'"]*['"]/,
      `${file} imports the test entry or the scripted agent`,
    );
  }
});

test('the shipped entry never hands the Host a quirks table of its own, and no shipped file reads one from the environment, a file or an argument', () => {
  const bin = fs.readFileSync(path.join(ROOT, 'host/bin/mopilot-host.mjs'), 'utf8');
  assert.doesNotMatch(bin, /momoOverrides|isolates/);
  for (const file of hostFiles(ROOT) as string[]) {
    if (!/\.(mjs|cjs|js)$/.test(file)) continue;
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/\bisolates\b/.test(line) && /process\.env|readFileSync|argv|JSON\.parse/.test(line))
        assert.fail(`${file}:${i + 1} reads isolation from outside the code: ${line.trim()}`);
    });
  }
  // the only places `momoOverrides` is named in the shipped Host: the serve entry's parameter and its pass-through
  const users = (hostFiles(ROOT) as string[]).filter(
    (f) => /\.(mjs|cjs|js)$/.test(f) && /momoOverrides/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')),
  );
  assert.deepEqual(users, ['host/src/cli.mjs']);
});

async function brain(t: any, options: object) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-brain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const records = new Map<string, any>();
  const sessions: any = {
    chats: { records, patchMeta: (id: string, patch: object) => records.set(id, { meta: { ...records.get(id)?.meta, ...patch } }) },
    isolated: () => true,
    isolate: () => undefined,
  };
  const home: any = momoHomeFor(
    {
      paths: { dataDir: path.join(dir, 'data'), configDir: path.join(dir, 'config') },
      report: () => undefined,
      sessions,
      epochs: { current: () => 1 } as any,
      hidden: createMomoHidden(),
      hostId: 'home-aaaa-1111',
      env: {},
    },
    options,
  );
  t.after(() => home.close());
  await home.grant({ account: 'a1', features: ['momo'] });
  await home.start({ name: 'Studio' });
  return home;
}

test('a Host as shipped refuses the scripted agent as MoMo’s brain; the test entry’s quirks accept it and only it', async (t) => {
  const shipped = await brain(t, {});
  await assert.rejects(
    shipped.chats.start({ harness: `acp:${SCRIPTED}` }),
    (e: any) => e.code === 'momo_brain_unavailable' && /can't be kept apart/.test(e.message),
  );
  const test_ = await brain(t, { quirks });
  assert.ok((await test_.chats.start({ harness: `acp:${SCRIPTED}` })).chatId);
  assert.equal(quirks('some-other-agent'), null, 'any other agent is held to its own quirks');
  assert.equal(typeof quirks(SCRIPTED).isolation.env, 'function');
  assert.equal(quirks(SCRIPTED).isolation.mode.mode, 'read-only');
});

test('the test entry defines the scripted agent in the Host’s own harnesses.json beside what is there, takes --seeds out of the arguments and reads the data folder', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-brain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'harnesses.json'), JSON.stringify({ other: { label: 'Other', bin: 'x', args: [] } }));
  defineScriptedAgent(dir);
  const defined = JSON.parse(fs.readFileSync(path.join(dir, 'harnesses.json'), 'utf8'));
  assert.deepEqual(Object.keys(defined).sort(), ['other', SCRIPTED]);
  assert.equal(defined[SCRIPTED].bin, process.execPath);
  assert.match(defined[SCRIPTED].args[0], /tests[\\/]fixtures[\\/]fake-acp-agent\.mjs$/);
  const fresh = path.join(dir, 'new', 'data');
  defineScriptedAgent(fresh);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(fresh, 'harnesses.json'), 'utf8'))), [SCRIPTED]);
  assert.deepEqual(splitArgs(['serve', '--data-dir', 'd', '--seeds', 's.mjs']), { rest: ['serve', '--data-dir', 'd'], seeds: 's.mjs' });
  assert.deepEqual(splitArgs(['serve']), { rest: ['serve'], seeds: null });
  assert.throws(() => splitArgs(['serve', '--seeds']), /needs the path/);
  assert.throws(() => splitArgs(['serve', '--seeds', '--data-dir', 'd']), /needs the path/);
  assert.equal(dataDirOf(['serve', '--data-dir', 'd']), 'd');
  assert.equal(dataDirOf(['serve']), undefined);
});

test('with the test entry’s quirks the scripted agent asks for no sign-in (the real fake agent is started and answers), and a Host as shipped does not know it', async () => {
  const bin = process.execPath;
  const seen = createNoSignIn({ env: {}, probeMs: 10_000, quirksOf: quirks });
  assert.equal(await seen.check(SCRIPTED, bin), true, 'the scripted agent lists no sign-in method, so it is ready');
  const shipped = createNoSignIn({ env: {}, probeMs: 10_000 });
  assert.equal(await shipped.check(SCRIPTED, bin), false, 'a Host as shipped has no quirks for it and counts it signed out');
});
