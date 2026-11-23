// get_settings and set_setting (electron/capabilities/tools/settingsTools.cjs): only the allowlisted display and sidebar
// settings, every change behind a consent card, nothing about permissions or security reachable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { registerSettingsTools, SETTINGS } = require('../electron/capabilities/tools/settingsTools.cjs');

function setup(over: { prefs?: any; allow?: boolean; saves?: boolean } = {}) {
  const prefs: any = over.prefs ?? {};
  const asked: any[] = [];
  const r = new Registry();
  registerSettingsTools(r, {
    owner: (ctx: any) => (ctx.segmentId === 'seg' ? ctx.chatId : null),
    prefs: () => prefs,
    patchPrefs: (set: any) => {
      if (over.saves === false) return false;
      Object.assign(prefs, set);
      return true;
    },
    ask: async (chat: string, summary: string, signal: unknown) => (
      asked.push([chat, summary, signal instanceof AbortSignal]), over.allow !== false
    ),
  });
  const call = async (tool: string, args: any, seg = 'seg') => {
    const res = await r.invoke('me', seg, tool, args);
    return res.ok ? JSON.parse(res.content[0].text) : { error: res.error };
  };
  return { r, call, prefs, asked };
}

test('the allowlist has no permission, security, browser or account setting', () => {
  for (const key of Object.keys(SETTINGS))
    assert.doesNotMatch(key, /permission|sandbox|approval|browser|chrome|account|token|key|shortcut|bindings/i);
});

test('get_settings: every allowlisted key with its saved value or the default, or just the keys asked for', async () => {
  const t = setup({ prefs: { theme: 'dark', wrapCode: 'maybe', permission: 'full-access' } });
  assert.equal(t.r.list().find((x: any) => x.name === 'get_settings').policy, 'observe');
  const all = (await t.call('get_settings', {})).settings;
  assert.deepEqual(
    all.map((s: any) => s.key),
    Object.keys(SETTINGS),
  );
  assert.deepEqual(
    all.find((s: any) => s.key === 'theme'),
    { key: 'theme', label: 'Theme', options: ['system', 'light', 'dark'], value: 'dark', default: false },
  );
  // a value that is not valid reads as unset; a permission pref is never listed
  assert.equal(all.find((s: any) => s.key === 'wrapCode').default, true);
  assert.equal(
    all.some((s: any) => s.key === 'permission'),
    false,
  );
  assert.deepEqual(
    (await t.call('get_settings', { keys: ['sendWith'] })).settings.map((s: any) => s.key),
    ['sendWith'],
  );
  assert.equal((await t.call('get_settings', { keys: ['permission'] })).error.code, 'bad_args');
  assert.equal((await t.call('get_settings', {}, 'stranger')).error.code, 'no_owner');
});

test('set_setting: asks the user, then saves; a refusal or a failed save changes nothing', async () => {
  const t = setup({ prefs: { theme: 'light' } });
  assert.equal(t.r.list().find((x: any) => x.name === 'set_setting').policy, 'act');
  const done = await t.call('set_setting', { key: 'theme', value: 'dark' });
  assert.deepEqual(done, { key: 'theme', value: 'dark', changed: true, said: 'Theme is now “dark”.' });
  assert.deepEqual(t.asked, [['me', 'set Theme to “dark”', true]]);
  assert.equal(t.prefs.theme, 'dark');
  // booleans, as the model may write them
  assert.equal((await t.call('set_setting', { key: 'wrapCode', value: 'true' })).value, true);
  assert.equal((await t.call('set_setting', { key: 'showReasoning', value: false })).value, false);
  assert.deepEqual([t.prefs.wrapCode, t.prefs.showReasoning], [true, false]);
  assert.equal((await t.call('set_setting', { key: 'wrapCode', value: 'false' })).said, 'Wrap long code lines is now false.');

  const asked = t.asked.length;
  assert.deepEqual(await t.call('set_setting', { key: 'theme', value: 'dark' }), {
    key: 'theme',
    value: 'dark',
    changed: false,
    said: 'It is already set to that.',
  });
  assert.equal(t.asked.length, asked, 'no card for a change that changes nothing');

  const no = setup({ allow: false });
  assert.equal((await no.call('set_setting', { key: 'theme', value: 'dark' })).error.code, 'denied');
  assert.equal(no.prefs.theme, undefined);
  const broken = setup({ saves: false });
  assert.equal((await broken.call('set_setting', { key: 'theme', value: 'dark' })).error.code, 'save_failed');
});

test('set_setting refuses a key off the list, prototype names and invalid values before any card', async () => {
  const t = setup();
  for (const key of ['permission', 'browserChannel', 'keybindings', 'constructor', '__proto__'])
    assert.equal((await t.call('set_setting', { key, value: 'x' })).error.code, 'not_allowed', key);
  assert.equal((await t.call('set_setting', { key: 'theme', value: 'purple' })).error.code, 'bad_args');
  assert.equal((await t.call('set_setting', { key: 'wrapCode', value: 'yes' })).error.code, 'bad_args');
  assert.equal((await t.call('set_setting', { key: 'theme', value: true })).error.code, 'bad_args');
  assert.deepEqual(t.asked, []);
  assert.deepEqual(t.prefs, {});
});
