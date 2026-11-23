// extensionInProfile: an extension on, off or missing in the Chrome profile a page opens in, from that profile's preferences.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { extensionInProfile } = require('../electron/capabilities/browser/chromeProfileExtension.cjs');

const ID = 'jhnfobeoiefjfneilcdkljfnapchmoej';
const ROOT = '/u/Chrome';

/** A Chrome user data folder of files (path → text); anything else is ENOENT. */
const fakeFs = (files: Record<string, string>) =>
  ({
    readFileSync: (p: string) => {
      if (Object.hasOwn(files, p)) return files[p];
      throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
    },
  }) as any;
const prefs = (settings: any) => JSON.stringify({ extensions: { settings } });
const at = (profile: string, name = 'Secure Preferences') => path.join(ROOT, profile, name);
const read = (files: Record<string, string>, o: any = {}) => extensionInProfile(ID, { userData: ROOT, fs: fakeFs(files), ...o });

test('on, off (a reason list, a reason bitmask, state 0) and missing, from Secure Preferences or Preferences', () => {
  assert.equal(read({ [at('Default')]: prefs({ [ID]: { path: '/x' } }) }), 'on');
  assert.equal(read({ [at('Default')]: prefs({ [ID]: { disable_reasons: [1] } }) }), 'off');
  assert.equal(read({ [at('Default')]: prefs({ [ID]: { disable_reasons: 8192 } }) }), 'off');
  assert.equal(read({ [at('Default')]: prefs({ [ID]: { disable_reasons: [], state: 0 } }) }), 'off');
  assert.equal(read({ [at('Default')]: prefs({ [ID]: { disable_reasons: [], state: 1 } }) }), 'on');
  // an entry that is no object, or another extension's, is not it
  assert.equal(read({ [at('Default')]: prefs({ [ID]: true, other: {} }) }), 'missing');
  // not in Secure Preferences: Preferences is read next
  assert.equal(read({ [at('Default')]: prefs({}), [at('Default', 'Preferences')]: prefs({ [ID]: {} }) }), 'on');
  assert.equal(read({ [at('Default', 'Preferences')]: '{}' }), 'missing');
});

test('the profile: the one named, else the one Chrome opens, else Default; the comparison folder when set; unreadable decides nothing', () => {
  const files = {
    [path.join(ROOT, 'Local State')]: JSON.stringify({ profile: { last_used: 'Profile 2' } }),
    [at('Profile 2')]: prefs({ [ID]: {} }),
    [at('Profile 3')]: prefs({}),
  };
  assert.equal(read(files), 'on');
  assert.equal(read(files, { profileDir: 'Profile 3' }), 'missing');
  // no Local State: Default, which isn't there
  assert.equal(read({ [at('Profile 2')]: prefs({ [ID]: {} }) }), null);
  assert.equal(read({ [at('Default')]: 'not json' }), null);
  // MOPILOT_CHROME_RELAY_USER_DATA_DIR is the folder the page opens in
  const scratch = '/s/compare';
  assert.equal(
    extensionInProfile(ID, {
      env: { MOPILOT_CHROME_RELAY_USER_DATA_DIR: scratch },
      fs: fakeFs({ [path.join(scratch, 'Default', 'Secure Preferences')]: prefs({}) }),
    }),
    'missing',
  );
  // Chrome's own folder when nothing is set (none here: unreadable)
  assert.equal(extensionInProfile(ID, { env: {}, fs: fakeFs({}) }), null);
});
