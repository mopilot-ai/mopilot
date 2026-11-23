// IPC for browser import (electron/app/ipc/browserImport.cjs): input is sanitised, a failure is data with its code, and the switch turns it off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { register, settle, FULL_DISK_ACCESS } = require('../electron/app/ipc/browserImport.cjs');
const { ImportError } = require('../electron/capabilities/browser/import/errors.cjs');

function setup(over: any = {}) {
  const handlers = new Map<string, (...a: any[]) => any>();
  const calls: any[] = [];
  const importer: any = {
    sources: () => [{ id: 'chrome' }],
    start: async (r: any) => (calls.push(['start', r]), over.start ? over.start() : { jobId: 'j1', sites: [], failed: {} }),
    run: async (r: any) => (calls.push(['run', r]), over.run ? over.run() : { history: { status: 'ok' } }),
    cancel: (id: string) => (calls.push(['cancel', id]), true),
    imported: () => ({ history: [] }),
    removeCookies: (s: any) => (calls.push(['removeCookies', s]), 2),
    deleteHistory: (s: any) => (calls.push(['deleteHistory', s]), 3),
    deleteBookmarks: (s: any) => (calls.push(['deleteBookmarks', s]), 4),
    deletePasswords: (s: any) => (calls.push(['deletePasswords', s]), 5),
    passwordFile: null as string | null,
    setPasswordFile(f: string | null) {
      calls.push(['setPasswordFile', f]);
      this.passwordFile = f;
    },
  };
  let on = true;
  const opened: string[] = [];
  register({ handle: (c: string, f: any) => handlers.set(c, f) } as any, {
    importer: () => importer,
    enabled: () => on,
    openExternal: async (u: string) => void opened.push(u),
    chooseFile: async (sender: any) => (
      calls.push(['chooseFile', sender]), over.chosen === undefined ? '/Users/me/Downloads/Passwords.csv' : over.chosen
    ),
    trash: async (f: string) => {
      calls.push(['trash', f]);
      if (over.trashError) throw over.trashError;
    },
  });
  return {
    call: (c: string, ...a: any[]) => handlers.get(c)!({ sender: 'win' }, ...a),
    calls,
    opened,
    importer,
    off: () => (on = false),
  };
}

test("settle: a step's result is data, and an error becomes its code and message", async () => {
  assert.deepEqual(await settle(async () => ({ a: 1 })), { ok: true, a: 1 });
  assert.deepEqual(
    await settle(async () => {
      throw new ImportError('busy', 'later');
    }),
    { ok: false, code: 'busy', message: 'later' },
  );
  assert.deepEqual(
    await settle(async () => {
      throw Object.assign(new Error('x'), { code: 'EPERM' });
    }),
    { ok: false, code: 'access_blocked', message: 'The system blocked access to the browser data.' },
  );
});

test('start and run: arguments are cleaned before they reach the importer', async () => {
  const t = setup();
  assert.deepEqual(
    await t.call('browser:import:start', {
      source: 'chrome',
      profile: 'Default',
      kinds: { bookmarks: 1, history: 0, cookies: true, extra: true },
    }),
    { ok: true, jobId: 'j1', sites: [], failed: {} },
  );
  assert.deepEqual(t.calls[0][1], {
    source: 'chrome',
    profile: 'Default',
    kinds: { bookmarks: true, history: false, cookies: true, passwords: false },
  });
  await t.call('browser:import:start', null);
  assert.deepEqual(t.calls[1][1], {
    source: '',
    profile: '',
    kinds: { bookmarks: false, history: false, cookies: false, passwords: false },
  });
  assert.deepEqual(await t.call('browser:import:run', { jobId: 'j1', sites: ['a.test', 5, 'b.test'] }), {
    ok: true,
    results: { history: { status: 'ok' } },
  });
  assert.deepEqual(t.calls[2][1], { jobId: 'j1', sites: ['a.test', '', 'b.test'] });
  await t.call('browser:import:run', { jobId: 7, sites: 'all' });
  assert.deepEqual(t.calls[3][1], { jobId: '', sites: [] });
});

test('import IPC keeps Unicode profile names whole at its input limit', async () => {
  const t = setup();
  const value = 'p'.repeat(199) + '🙂tail';
  const expected = 'p'.repeat(199) + '🙂';
  await t.call('browser:import:start', { profile: value });
  assert.equal(t.calls[0][1].profile, expected);
  await t.call('browser:import:run', { sites: [value] });
  assert.deepEqual(t.calls[1][1].sites, [expected]);
});

test('a failing step answers with its code', async () => {
  const t = setup({
    start: () => Promise.reject(new ImportError('keychain_denied', 'no')),
    run: () => Promise.reject(new ImportError('cancelled', 'gone')),
  });
  assert.deepEqual(await t.call('browser:import:start', {}), { ok: false, code: 'keychain_denied', message: 'no' });
  assert.deepEqual(await t.call('browser:import:run', {}), { ok: false, code: 'cancelled', message: 'gone' });
});

test('the other handlers pass cleaned arguments through', async () => {
  const t = setup();
  assert.deepEqual(await t.call('browser:import:sources'), [{ id: 'chrome' }]);
  assert.equal(await t.call('browser:import:cancel', 'j1'), true);
  assert.equal(await t.call('browser:import:cancel', 9), true);
  assert.deepEqual(await t.call('browser:import:imported'), { history: [] });
  assert.equal(await t.call('browser:import:removeCookies', 'example.com'), 2);
  assert.equal(await t.call('browser:import:removeCookies'), 2);
  assert.equal(await t.call('browser:import:deleteHistory', 'chrome'), 3);
  assert.equal(await t.call('browser:import:deleteHistory'), 3);
  assert.equal(await t.call('browser:import:deleteBookmarks', 'safari'), 4);
  assert.equal(await t.call('browser:import:deleteBookmarks'), 4);
  assert.equal(await t.call('browser:import:deletePasswords', 'chrome'), 5);
  assert.equal(await t.call('browser:import:deletePasswords'), 5);
  assert.deepEqual(
    t.calls.map((c: any) => c.join(':')),
    [
      'cancel:j1',
      'cancel:',
      'removeCookies:example.com',
      'removeCookies:',
      'deleteHistory:chrome',
      'deleteHistory:',
      'deleteBookmarks:safari',
      'deleteBookmarks:',
      'deletePasswords:chrome',
      'deletePasswords:',
    ],
  );
  await t.call('browser:import:openFullDiskAccess');
  assert.deepEqual(t.opened, [FULL_DISK_ACCESS]);
});

test('with the switch off, sources are empty and start and run refuse', async () => {
  const t = setup();
  t.off();
  assert.deepEqual(await t.call('browser:import:sources'), []);
  assert.deepEqual((await t.call('browser:import:start', {})).code, 'unsupported');
  assert.deepEqual((await t.call('browser:import:run', {})).code, 'unsupported');
  assert.equal(t.calls.length, 0);
});

test("Safari's passwords file: the user picks it (the renderer learns only its name), and may send it to the Trash", async () => {
  const t = setup();
  assert.deepEqual(await t.call('browser:import:trashPasswordFile'), {
    ok: false,
    code: 'no_file',
    message: 'No passwords file was chosen.',
  });
  assert.deepEqual(await t.call('browser:import:choosePasswordFile'), { name: 'Passwords.csv' });
  assert.equal(t.importer.passwordFile, '/Users/me/Downloads/Passwords.csv');
  assert.deepEqual(await t.call('browser:import:trashPasswordFile'), { ok: true });
  assert.equal(t.importer.passwordFile, null);
  assert.deepEqual(
    t.calls.map((c: any[]) => c.join(':')),
    ['chooseFile:win', 'setPasswordFile:/Users/me/Downloads/Passwords.csv', 'trash:/Users/me/Downloads/Passwords.csv', 'setPasswordFile:'],
  );
  // the Trash refusing keeps the file chosen
  const failing = setup({ trashError: new Error('no Trash on this volume') });
  await failing.call('browser:import:choosePasswordFile');
  assert.equal((await failing.call('browser:import:trashPasswordFile')).ok, false);
  assert.equal(failing.importer.passwordFile, '/Users/me/Downloads/Passwords.csv');
  // cancelling the panel, or the switch off: nothing chosen
  const cancelled = setup({ chosen: null });
  assert.equal(await cancelled.call('browser:import:choosePasswordFile'), null);
  assert.equal(cancelled.importer.passwordFile, null);
  cancelled.off();
  assert.equal(await cancelled.call('browser:import:choosePasswordFile'), null);
  assert.equal(cancelled.calls.filter((c: any[]) => c[0] === 'chooseFile').length, 1);
});
