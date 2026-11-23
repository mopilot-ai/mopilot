// The owner's permission ceiling on a Claude Code chat's turns (host/src/claudeFamily.mjs savedSettings, shared/host/policy.mjs clampToCeiling): the mode a turn runs under never exceeds it, whenever the chat's mode was set and whatever the ceiling was then.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, until, keyOf, idle } from './support/host/claudeKit.ts';

test('a chat set to full access runs its next turns under a ceiling that dropped since: the live CLI is brought down, and into read-only the CLI restarts under it', async () => {
  let max: string | undefined = 'full-access';
  const h = setup(undefined, undefined, () => max);
  try {
    const key = keyOf();
    await h.sessions.chatRuntime.prepare({ chatId: key, harness: 'claude', cwd: h.dir });
    await h.sessions.chatRuntime.setMode({ chatId: key, value: 'full-access' });
    await h.sessions.chatRuntime.send({ key, text: 'first', cwd: h.dir });
    await idle(h, key);
    assert.equal(h.fake.queries[0].options.permissionMode, 'bypassPermissions');
    // the ceiling drops to "ask first": the stored mode is untouched, the next turn runs under the ceiling
    max = 'default';
    await h.sessions.chatRuntime.send({ key, text: 'second' });
    await until(() => h.of('turnEnd', key).length > 1);
    assert.equal(h.sessions.chats.records.get(key).meta.config.permission, 'full-access', 'what the person chose is kept');
    assert.ok(
      h.fake.queries[0].controls.some((c: any[]) => c[0] === 'setPermissionMode' && c[1] === 'default'),
      'the live CLI was brought down to the ceiling',
    );
    // to read-only: that is another CLI (a move into read-only restarts it), started under it
    max = 'read-only';
    await h.sessions.chatRuntime.send({ key, text: 'third' });
    await until(() => h.of('turnEnd', key).length > 2);
    assert.equal(h.fake.queries.length, 2, 'a CLI started for read-only');
    assert.equal(h.fake.queries[1].options.permissionMode, 'dontAsk');
    // the ceiling goes away: the chat's own mode is back
    max = undefined;
    await h.sessions.chatRuntime.send({ key, text: 'fourth' });
    await until(() => h.of('turnEnd', key).length > 3);
    assert.equal(h.fake.queries.at(-1).options.permissionMode, 'bypassPermissions');
  } finally {
    await h.close();
  }
});
