// The production Claude control routes additive directory grants to the current SDK process and rejects a process retired during its read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakes, load, fakeBin, lastQuery } from './support/electron-claude.ts';

test('directory grants use the native control entrypoint and never apply to a process closed while reading settings', async () => {
  const t = load();
  const bin = fakeBin('linked-directory/claude');
  fakes.onQuery = (q: any) => {
    q.getSettings = async () => ({
      effective: { permissions: { deny: ['Bash(rm:*)'] } },
      sources: [{ source: 'flagSettings', settings: { permissions: { deny: ['Bash(rm:*)'] } } }],
      applied: { model: 'fixture', ultracode: false },
    });
    q.listPermissionRules = async () => ({ state: { workspaceDirectories: [{ path: '/prior' }] } });
  };
  const key = 'claude:linked-directories';
  await t.claude.send(key, { bin, sessionId: 'linked-directories', ephemeral: true }, { role: 'user', content: 'hello' });
  const q = lastQuery();
  assert.equal(await t.call('claude:control', key, 'addDirectories', ['/notes']), true);
  assert.ok(q.calls.some((call: any) => call[0] === 'applyFlagSettings' && call[1].permissions?.additionalDirectories.includes('/notes')));
  q.getSettings = async () => {
    await t.call('claude:control', key, 'close');
    return { sources: [], applied: { model: 'fixture' } };
  };
  await assert.rejects(t.call('claude:control', key, 'addDirectories', ['/other']), /process changed/);
});
