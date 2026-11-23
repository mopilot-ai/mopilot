// What `mopilot-host uninstall` keeps and `--purge` deletes (#4721 follow-up): plain uninstall keeps the Host's data and identity so a reinstall resumes and says so; `--purge`, and the app's Remove on a machine, delete the same set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { main } from '../host/src/cli.mjs';
// @ts-ignore: plain ESM without declarations
import { createPaths } from '../host/src/paths.mjs';
// @ts-ignore: plain ESM without declarations
import { purgeTargets } from '../host/src/uninstallCommand.mjs';

const require = createRequire(import.meta.url);
const { PURGE } = require('../electron/host/uninstallHost.cjs');

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-purge-test-')));
const io = (home: string, env: Record<string, string> = {}, extra: Record<string, unknown> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      stopService: () => {},
      home,
      platform: 'linux' as NodeJS.Platform,
      env,
      ...extra,
    },
  };
};
/** What a paired Host leaves: chats, identity, the pairing and the relay enrollment. */
const fill = (data: string, config: string) => {
  fs.mkdirSync(path.join(data, 'threads'), { recursive: true });
  fs.writeFileSync(path.join(data, 'threads', 'a.jsonl'), '{}\n');
  fs.mkdirSync(config, { recursive: true });
  for (const name of ['host-id', 'pairing.json', 'relay.json', 'secrets.json']) fs.writeFileSync(path.join(config, name), 'x');
};

test('plain uninstall removes the service, keeps the data and identity, and says how to delete them', async () => {
  const home = tmp();
  const data = path.join(home, 'host-data');
  const config = path.join(data, 'config');
  fill(data, config);
  const r = io(home);
  assert.equal(await main(['uninstall', '--data-dir', data], r.io), 0);
  for (const name of ['host-id', 'pairing.json', 'relay.json']) assert.ok(fs.existsSync(path.join(config, name)), `${name} is kept`);
  assert.ok(fs.existsSync(path.join(data, 'threads', 'a.jsonl')), 'the chats are kept');
  assert.match(r.out.join('\n'), /Kept .*host-data and .*config: .*pairings.*mopilot-host uninstall --purge/);
});

test('--purge deletes the data folder with its config (another Host keeps its config inside), and a second one finds nothing', async () => {
  const home = tmp();
  const data = path.join(home, 'host-data');
  fill(data, path.join(data, 'config'));
  const r = io(home);
  assert.equal(await main(['uninstall', '--purge', '--data-dir', data], r.io), 0);
  assert.ok(!fs.existsSync(data));
  assert.ok(r.out.some((l) => l === `Deleted ${data}`));
  const again = io(home);
  assert.equal(await main(['uninstall', '--purge', '--data-dir', data], again.io), 0);
  assert.ok(!again.out.some((l) => l.startsWith('Deleted')), 'nothing left to delete');
});

test('--purge on the default Host deletes its data and its config folder next to the person’s other config, which stays', async () => {
  const home = tmp();
  const env = { XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share') };
  const was = process.env.HOME;
  process.env.HOME = home;
  try {
    const { dataDir, configDir } = createPaths({ env, platform: process.platform, home });
    fill(dataDir, configDir);
    fs.mkdirSync(path.join(home, '.config', 'other'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'other', 'keep'), 'x');
    const r = io(home, env, { platform: process.platform });
    assert.equal(await main(['uninstall', '--purge'], r.io), 0);
    assert.ok(!fs.existsSync(dataDir) && !fs.existsSync(configDir));
    assert.ok(fs.existsSync(path.join(home, '.config', 'other', 'keep')));
  } finally {
    if (was === undefined) delete process.env.HOME;
    else process.env.HOME = was;
  }
});

test('--purge leaves a folder that is not plainly a Host’s (and a config inside it), and says so', async () => {
  const home = tmp();
  const documents = path.join(home, 'Documents');
  fs.mkdirSync(path.join(documents, 'config'), { recursive: true });
  fs.writeFileSync(path.join(documents, 'config', 'mine'), 'x');
  fs.writeFileSync(path.join(documents, 'notes.txt'), 'x');
  const r = io(home);
  assert.equal(await main(['uninstall', '--purge', '--data-dir', documents], r.io), 0);
  assert.ok(fs.existsSync(path.join(documents, 'notes.txt')) && fs.existsSync(path.join(documents, 'config', 'mine')));
  assert.match(r.out.join('\n'), /Kept .*Documents: it does not look like a Host's folder/);
});

test('the install tree is deleted only when this command runs from it, never a checkout', () => {
  const home = '/h';
  const base = { home, dataDir: '/h/data', configDir: '/h/data/config' };
  assert.ok(purgeTargets({ ...base, binPath: '/h/.mopilot-host/host/bin/mopilot-host.mjs' }).remove.includes('/h/.mopilot-host'));
  assert.ok(!purgeTargets({ ...base, binPath: '/work/repo/host/bin/mopilot-host.mjs' }).remove.includes('/h/.mopilot-host'));
});

test('a Host that starts at boot is not purged: nothing is deleted', async () => {
  const home = tmp();
  const data = path.join(home, 'host-data');
  fill(data, path.join(data, 'config'));
  const plist = path.join(home, 'daemon.plist');
  fs.writeFileSync(plist, 'x');
  const r = io(home, {}, { platform: 'darwin', daemonPlist: plist });
  assert.equal(await main(['uninstall', '--purge', '--data-dir', data], r.io), 1);
  assert.ok(fs.existsSync(path.join(data, 'config', 'pairing.json')));
  assert.match(r.err.join('\n'), /starts at boot/);
});

test('the app’s Remove and `uninstall --purge` delete the same files of a default Host and leave the same ones', async () => {
  const layout = (home: string) => {
    const env = { XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share') };
    const { dataDir, configDir } = createPaths({ env, platform: process.platform, home });
    fill(dataDir, configDir);
    // the install tree, and what is not the Host's
    fs.mkdirSync(path.join(home, '.mopilot-host', 'host', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.mopilot-host', 'host', 'bin', 'mopilot-host.mjs'), 'x');
    fs.mkdirSync(path.join(home, '.config', 'other'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'other', 'keep'), 'x');
    return env;
  };
  const listing = (home: string) => {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else found.push(path.relative(home, file));
      }
    };
    walk(home);
    return found.sort();
  };

  const viaApp = tmp();
  layout(viaApp);
  const ran = spawnSync('/bin/sh', ['-c', PURGE], { env: { PATH: process.env.PATH, HOME: viaApp }, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);

  // the CLI as the app installs it: run from the install tree under the home folder
  const viaCli = tmp();
  const env = layout(viaCli);
  const was = process.env.HOME;
  process.env.HOME = viaCli;
  try {
    const r = io(viaCli, env, { platform: process.platform });
    // main finds its own bin through import.meta.url, which is this checkout: the install tree is deleted only from itself, so it is checked by purgeTargets above
    assert.equal(await main(['uninstall', '--purge'], r.io), 0);
  } finally {
    if (was === undefined) delete process.env.HOME;
    else process.env.HOME = was;
  }
  fs.rmSync(path.join(viaCli, '.mopilot-host'), { recursive: true, force: true });

  assert.deepEqual(listing(viaCli), listing(viaApp));
  assert.deepEqual(listing(viaApp), [path.join('.config', 'other', 'keep')]);
});

test('--purge deletes the data folder when the Host never paired (no config folder) and with no home folder given', async () => {
  const data = path.join(tmp(), 'host-data');
  fs.mkdirSync(path.join(data, 'threads'), { recursive: true });
  const r = io(tmp(), {}, { home: undefined });
  assert.equal(await main(['uninstall', '--purge', '--data-dir', data], r.io), 0);
  assert.ok(!fs.existsSync(data));
  assert.deepEqual(
    r.out.filter((l) => l.startsWith('Deleted')),
    [`Deleted ${data}`],
  );
});
