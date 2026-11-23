// Adding a shared directory preserves flag rules and other native-owned sources, serializes writers and stops at every retired-process boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { addDirectories } = require('../electron/harness/claude/directoryGrants.cjs');
const { replyPermission } = require('../electron/harness/claude/permissionReplies.cjs');

function fixture() {
  const calls: any[] = [];
  let permissions: any = { allow: ['Read(/existing/**)'], deny: ['Bash(rm:*)'], ask: ['Bash(git:*)'], additionalDirectories: ['/saved'] };
  const session = {
    q: {
      getSettings: async () => ({ sources: [{ source: 'flagSettings', settings: { permissions } }] }),
      applyFlagSettings: async (value: any) => {
        calls.push(value);
        permissions = value.permissions;
      },
    },
  };
  return { session, calls };
}

test('additive grants retain all flag permission fields across serialized writes without copying other native-owned sources', async () => {
  const f = fixture();
  await Promise.all([addDirectories(f.session, ['/one'], () => {}), addDirectories(f.session, ['/two'], () => {})]);
  assert.deepEqual(f.calls[0].permissions, {
    allow: ['Read(/existing/**)'],
    deny: ['Bash(rm:*)'],
    ask: ['Bash(git:*)'],
    additionalDirectories: ['/saved', '/one'],
  });
  assert.deepEqual(f.calls[1].permissions.additionalDirectories, ['/saved', '/one', '/two']);
});

test('unknown native settings or scope cannot be replaced with guessed permissions', async () => {
  for (const response of [
    null,
    {},
    { sources: null },
    { sources: {} },
    { sources: [null] },
    { sources: [[]] },
    { sources: [{ source: 'unknown', settings: {} }] },
    { sources: [{ source: 'flagSettings', settings: null }] },
    { sources: [{ source: 'flagSettings', settings: [] }] },
    {
      sources: [
        { source: 'flagSettings', settings: {} },
        { source: 'flagSettings', settings: {} },
      ],
    },
  ]) {
    const f = fixture();
    f.session.q.getSettings = async () => response as any;
    await assert.rejects(
      addDirectories(f.session, ['/notes'], () => {}),
      /permission settings sources/,
    );
    assert.deepEqual(f.calls, []);
  }
  for (const permissions of [null, [], 'invalid', { allow: 'invalid' }, { deny: [1] }, { ask: null }]) {
    const f = fixture();
    f.session.q.getSettings = async () => ({ sources: [{ source: 'flagSettings', settings: { permissions } }] }) as any;
    await assert.rejects(
      addDirectories(f.session, ['/notes'], () => {}),
      /valid flag permission/,
    );
    assert.deepEqual(f.calls, []);
  }
  for (const saved of ['bad', [1], null]) {
    const f = fixture();
    f.session.q.getSettings = async () =>
      ({ sources: [{ source: 'flagSettings', settings: { permissions: { additionalDirectories: saved } } }] }) as any;
    await assert.rejects(
      addDirectories(f.session, ['/notes'], () => {}),
      /did not report its directory/,
    );
  }
  const empty = fixture();
  empty.session.q.getSettings = async () => ({ sources: [{ source: 'flagSettings', settings: { permissions: {} } }] }) as any;
  await addDirectories(empty.session, ['/notes'], () => {});
  assert.deepEqual(empty.calls, [{ permissions: { additionalDirectories: ['/notes'] } }]);
});

test('process retirement at each await stops continuation; a failed queued grant does not prevent a later valid retry', async () => {
  for (const retireAt of [1, 2, 3]) {
    const f = fixture();
    let checks = 0;
    await assert.rejects(
      addDirectories(f.session, ['/notes'], () => {
        if (++checks === retireAt) throw new Error('retired');
      }),
      /retired/,
    );
    assert.equal(f.calls.length, retireAt === 3 ? 1 : 0);
  }
  const f = fixture();
  const failed = addDirectories(f.session, ['/one'], () => {
    throw new Error('retired');
  });
  const good = addDirectories(f.session, ['/two'], () => {});
  await assert.rejects(failed, /retired/);
  await good;
  assert.equal(f.calls.length, 1);
});

test('permission replies settle only the owning live request and update that process activity', () => {
  const values: any[] = [];
  const other = { perms: new Map(), lastActive: 0 };
  const owner = { perms: new Map([['request', (value: any) => values.push(value)]]), lastActive: 0 };
  const state = {
    sessions: new Map([
      ['other', other],
      ['owner', owner],
    ]),
  };
  assert.equal(replyPermission(state, 'missing', {}), false);
  assert.equal(replyPermission(state, 'request', { allow: true }), true);
  assert.deepEqual(values, [{ allow: true }]);
  assert.ok(owner.lastActive > 0);
  assert.equal(other.lastActive, 0);
  assert.equal(replyPermission(state, 'request', {}), false);
});
