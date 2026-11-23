// What `mopilot-host install` tells the person to run to start the service (host/src/install.mjs): a Host that is already running must restart onto the new files on both platforms, as the app's installer does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { installUnit } from '../host/src/install.mjs';
// @ts-ignore: plain ESM without declarations
import { launchdStart } from '../shared/host/launchd.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'install-unit-'));
const unit = { home, env: {}, nodePath: '/n', binPath: '/b', dataDir: '/d' };

test('I: the start command for a unit restarts a running service on Linux (systemd) and reloads the agent on macOS (launchd)', () => {
  const lin = installUnit({ ...unit, platform: 'linux' });
  assert.equal(
    lin.start,
    'systemctl --user daemon-reload && systemctl --user enable mopilot-host && systemctl --user restart mopilot-host',
  );
  assert.ok(fs.existsSync(lin.file));
  const mac = installUnit({ ...unit, platform: 'darwin' });
  assert.equal(mac.start, launchdStart(`'${mac.file}'`));
  assert.ok(fs.existsSync(mac.file));
  // a home folder with a space or a quote in its name stays one word for the shell
  const odd = installUnit({ ...unit, home: path.join(home, "Jane O'Doe"), platform: 'darwin' });
  assert.ok(odd.start.includes(`launchctl bootstrap "$D" '${odd.file.replace(/'/g, "'\\''")}'`), odd.start);
});
