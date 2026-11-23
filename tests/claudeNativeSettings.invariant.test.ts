// Production native controls use the shipped settings provenance contract and serialize permission mutations within one actual SDK session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakes, load, fakeBin, lastQuery, flush } from './support/electron-claude.ts';
import { deferred } from './support/async-scenarios.ts';

export const GUARDS = ['electron/', 'shared/'];

async function native() {
  const t = load();
  const bin = fakeBin('native-settings/claude');
  const key = 'claude:settings-contract';
  await t.claude.send(key, { bin, sessionId: 'settings-contract', ephemeral: true }, { role: 'user', content: 'fixture' });
  const q = lastQuery();
  let flags: any = { permissions: { deny: ['Bash(rm:*)'], additionalDirectories: ['/flag-dir'] } };
  let lower: any = { permissions: { allow: ['Read(/user/**)'], defaultMode: 'bypassPermissions', additionalDirectories: ['/user-dir'] } };
  const events: any[] = [];
  const response = () =>
    structuredClone({
      effective: { ...lower, ...flags },
      sources: [
        { source: 'userSettings', settings: lower },
        ...(Object.keys(flags).length ? [{ source: 'flagSettings', settings: flags }] : []),
      ],
      applied: { model: 'fixture', effort: 'high', advisor: null, ultracode: false, ultracodeRequested: false, ultracodeAvailable: false },
    });
  q.getSettings = async () => {
    events.push(['read']);
    return response();
  };
  q.applyFlagSettings = async (patch: any) => {
    events.push(['flags', patch]);
    flags = { ...flags, ...patch };
  };
  q.setPermissionMode = async (mode: string) => {
    events.push(['mode', mode]);
  };
  return {
    ...t,
    key,
    bin,
    q,
    events,
    response,
    flags: () => flags,
    setFlags: (value: any) => {
      flags = value;
    },
    setLower: (value: any) => {
      lower = value;
    },
  };
}

test('actual get_settings sources grant live notes without pinning lower ACL or directories after those sources remove them', async () => {
  const h = await native();
  assert.equal(await h.call('claude:control', h.key, 'addDirectories', ['/notes']), true);
  assert.deepEqual(h.flags().permissions, { deny: ['Bash(rm:*)'], additionalDirectories: ['/flag-dir', '/notes'] });
  h.setLower({ permissions: {} });
  assert.equal(await h.call('claude:control', h.key, 'addDirectories', ['/next-notes']), true);
  assert.deepEqual(h.flags().permissions, { deny: ['Bash(rm:*)'], additionalDirectories: ['/flag-dir', '/notes', '/next-notes'] });
  assert.equal(h.flags().permissions.allow, undefined);
  assert.equal(h.flags().permissions.defaultMode, undefined);
  h.setFlags({});
  await h.call('claude:control', h.key, 'addDirectories', ['/empty-layer']);
  assert.deepEqual(h.flags(), { permissions: { additionalDirectories: ['/empty-layer'] } });
  h.setFlags({ fastMode: true });
  await h.call('claude:control', h.key, 'addDirectories', ['/other-setting']);
  assert.deepEqual(h.flags(), { fastMode: true, permissions: { additionalDirectories: ['/other-setting'] } });
});

test('flag ACL writer success or rejection releases the following grant and mode change in native request order', async () => {
  for (const fails of [false, true]) {
    const h = await native();
    const writing = deferred<void>();
    const entered = deferred<void>();
    const apply = h.q.applyFlagSettings;
    let first = true;
    h.q.applyFlagSettings = async (patch: any) => {
      if (first) {
        first = false;
        entered.resolve();
        await writing.promise;
      }
      return apply(patch);
    };
    const writer = h.call('claude:control', h.key, 'applyFlagSettings', {
      permissions: { ask: ['Bash(git:*)'], additionalDirectories: ['/new-dir'] },
    });
    const writerResult = fails ? assert.rejects(writer, /rejected writer/) : writer;
    await entered.promise;
    const grant = h.call('claude:control', h.key, 'addDirectories', ['/notes']);
    const mode = h.call('claude:control', h.key, 'setPermissionMode', 'default');
    await flush();
    assert.deepEqual(h.events, [], 'later reads and mode changes wait until the earlier flag mutation settles');
    if (fails) writing.reject(new Error('rejected writer'));
    else writing.resolve();
    await writerResult;
    assert.equal(await grant, true);
    await mode;
    assert.deepEqual(
      h.flags().permissions,
      fails
        ? { deny: ['Bash(rm:*)'], additionalDirectories: ['/flag-dir', '/notes'] }
        : { ask: ['Bash(git:*)'], additionalDirectories: ['/new-dir', '/notes'] },
    );
    assert.deepEqual(
      h.events.filter((event) => event[0] === 'mode'),
      [['mode', 'default']],
    );
  }
});

test('a later explicit flag replacement runs after a pending notes read and retains the user-selected ACL', async () => {
  const h = await native();
  const reading = deferred<void>();
  const entered = deferred<void>();
  const get = h.q.getSettings;
  h.q.getSettings = async () => {
    entered.resolve();
    await reading.promise;
    return get();
  };
  const grant = h.call('claude:control', h.key, 'addDirectories', ['/notes']);
  await entered.promise;
  const writer = h.call('claude:control', h.key, 'applyFlagSettings', { permissions: { deny: ['Read(/secret/**)'] } });
  await flush();
  assert.deepEqual(h.events, []);
  reading.resolve();
  await grant;
  await writer;
  assert.deepEqual(h.flags().permissions, { deny: ['Read(/secret/**)'] });
});

test('replacement SDK sessions are independent and old reads or queued mutations never act on the replacement', async () => {
  const h = await native();
  const reading = deferred<void>();
  const entered = deferred<void>();
  h.q.getSettings = async () => {
    entered.resolve();
    await reading.promise;
    return h.response();
  };
  const grant = h.call('claude:control', h.key, 'addDirectories', ['/old']);
  const rejectedGrant = assert.rejects(grant, /process changed/);
  await entered.promise;
  const flags = h.call('claude:control', h.key, 'applyFlagSettings', { permissions: { deny: ['old'] } });
  const rejectedFlags = assert.rejects(flags, /process changed/);
  const mode = h.call('claude:control', h.key, 'setPermissionMode', 'plan');
  const rejectedMode = assert.rejects(mode, /process changed/);
  await h.call('claude:control', h.key, 'close');
  fakes.onQuery = (q: any) => {
    q.setPermissionMode = async (value: string) => {
      h.events.push(['new-mode', value]);
    };
  };
  await h.claude.send(h.key, { bin: h.bin, sessionId: 'settings-contract', ephemeral: true }, { role: 'user', content: 'replacement' });
  assert.notEqual(lastQuery(), h.q);
  await h.call('claude:control', h.key, 'setPermissionMode', 'default');
  assert.deepEqual(h.events, [['new-mode', 'default']], 'replacement mutation is not held behind the old process read');
  reading.resolve();
  await rejectedGrant;
  await rejectedFlags;
  await rejectedMode;
  assert.deepEqual(h.events, [['new-mode', 'default']]);
});
