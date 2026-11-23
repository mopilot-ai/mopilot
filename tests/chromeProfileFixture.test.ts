// The E2E Chrome fixture's pure parts (tests/e2e/fixtures/chromeProfile.ts): the DevTools port Chrome writes, and the scratch profile the app is pointed at.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CHROME_BIN, chromeBin, devToolsPort, scratchChromeProfile } from './e2e/fixtures/chromeProfile.ts';

test('devToolsPort reads the first line of DevToolsActivePort, and nothing before Chrome wrote one', () => {
  assert.equal(devToolsPort('53211\n/devtools/browser/abc'), 53211);
  assert.equal(devToolsPort(null), null);
  assert.equal(devToolsPort(''), null);
  assert.equal(devToolsPort('0\n'), null);
  assert.equal(devToolsPort('not a port'), null);
  assert.equal(devToolsPort('532'), null, 'a numeric prefix is still being written');
  assert.equal(devToolsPort('65536\n'), null);
  assert.equal(devToolsPort('53211\r\n/devtools/browser/abc'), 53211);
});

test('a scratch profile points the app at its folder only, and is made and removed whole', () => {
  const a = scratchChromeProfile();
  const b = scratchChromeProfile();
  assert.notEqual(a.dir, b.dir);
  assert.deepEqual(a.env, {
    MOPILOT_CHROME_NATIVE_HOST: '1',
    MOPILOT_CHROME_RELAY_USER_DATA_DIR: a.dir,
    MOPILOT_CHROME_RELAY_EXECUTABLE: CHROME_BIN,
  });
  assert.equal(fs.existsSync(a.dir), false);
  a.create();
  fs.writeFileSync(`${a.dir}/x`, '');
  assert.equal(fs.existsSync(a.dir), true);
  a.remove();
  assert.equal(fs.existsSync(a.dir), false);
});

test('scratch cleanup preserves other profiles, is idempotent and keeps filesystem refusals visible', (t) => {
  const a = scratchChromeProfile();
  const b = scratchChromeProfile();
  t.after(() => a.remove());
  t.after(() => b.remove());
  a.create();
  b.create();
  fs.writeFileSync(`${b.dir}/keep`, 'another profile');
  const denied = Object.assign(new Error('profile removal refused'), { code: 'EACCES' });
  const remove = t.mock.method(fs, 'rmSync', () => {
    throw denied;
  });
  try {
    assert.throws(
      () => a.remove(),
      (error) => error === denied,
    );
    assert.equal(fs.existsSync(a.dir), true);
  } finally {
    remove.mock.restore();
  }
  a.remove();
  a.remove();
  assert.equal(fs.existsSync(a.dir), false);
  assert.equal(fs.readFileSync(`${b.dir}/keep`, 'utf8'), 'another profile');
});

test('Chrome’s default path is the platform’s own, and CHROME_BIN wins', () => {
  assert.equal(chromeBin('linux', {}), '/usr/bin/google-chrome');
  assert.equal(chromeBin('darwin', {}), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  assert.equal(chromeBin('win32', {}), 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  assert.equal(chromeBin('win32', { ProgramFiles: 'D:\\Apps' }), 'D:\\Apps\\Google\\Chrome\\Application\\chrome.exe');
  assert.equal(chromeBin('linux', { CHROME_BIN: '/x/chrome' }), '/x/chrome');
  assert.equal(typeof CHROME_BIN, 'string');
  assert.equal(typeof chromeBin(), 'string');
});
