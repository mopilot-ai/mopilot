// The installed Host and the CLI agree on where the Host's files are (host/src/install.mjs renderUnit, host/src/paths.mjs): the --data-dir a launchd or systemd unit starts the server with resolves to the same config, so a code `mopilot-host pair` prints is the code the running server checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { renderUnit } from '../host/src/install.mjs';
// @ts-ignore: plain ESM without declarations
import { createPaths } from '../host/src/paths.mjs';

/** The --data-dir the unit's ServeS command carries, read from the rendered text. */
function dataDirOf(platform: 'darwin' | 'linux', text: string): string {
  const args =
    platform === 'darwin'
      ? [...text.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1].replaceAll('&amp;', '&'))
      : /ExecStart=(.*)/
          .exec(text)![1]
          .split(/ (?=(?:[^"]*"[^"]*")*[^"]*$)/)
          .map((a) => a.replace(/^"|"$/g, ''));
  const at = args.indexOf('--data-dir');
  assert.ok(at >= 0, `${platform}: the unit starts the server with a --data-dir`);
  return args[at + 1];
}

for (const platform of ['darwin', 'linux'] as const) {
  test(`${platform}: the installed unit's server and a later plain \`mopilot-host\` command use the same config folder`, () => {
    const home = '/Users/me';
    const plain = createPaths({ platform, home, env: {} });
    // `install` writes the unit with the CLI's own paths
    const { text } = renderUnit({ platform, home, env: {}, nodePath: '/n/node', binPath: '/b/mopilot-host.mjs', dataDir: plain.dataDir });
    const served = createPaths({ platform, home, env: {}, dataDir: dataDirOf(platform, text) });
    assert.equal(served.configDir, plain.configDir, 'pairing.json, the update key and the secrets');
    assert.equal(served.dataDir, plain.dataDir);
    assert.equal(served.socketPath, plain.socketPath);
  });
}
