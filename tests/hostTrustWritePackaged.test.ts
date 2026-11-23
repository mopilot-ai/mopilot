// Host trust writes in the installed layout: runtime imports must work when the shipped runtime trees are present and development scripts are absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

test('the shipped runtime can acquire and release trust without a scripts directory', () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-host-trust-'));
  try {
    for (const dir of ['host/src', 'electron', 'shared'])
      fs.cpSync(path.resolve(import.meta.dirname, '..', dir), path.join(app, dir), {
        recursive: true,
        filter: (source) => path.basename(source) !== 'node_modules',
      });
    const module = pathToFileURL(path.join(app, 'host/src/trustWrite.mjs')).href;
    const config = path.join(app, 'config');
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { withTrustWrite } from ${JSON.stringify(module)};
      console.log(withTrustWrite(${JSON.stringify(config)}, () => 'owned'));
    `,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(output.trim(), 'owned');
    assert.equal(fs.existsSync(path.join(config, 'trust-write.lock')), false);
    assert.equal(fs.existsSync(path.join(app, 'scripts')), false);
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});
