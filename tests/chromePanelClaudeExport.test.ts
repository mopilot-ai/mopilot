// Chrome-panel title reads exercise the actual Claude module export and shared SDK reader, not an invented optional API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakes, load } from './support/electron-claude.ts';
const require = createRequire(import.meta.url);
const { panelIdentity } = require('../electron/app/chromePanelIdentity.cjs');

test('the public Claude reader and desktop IPC share native session information with the panel', async () => {
  const actual = load();
  const before = fakes.sdk.getSessionInfo;
  const calls: string[] = [];
  fakes.sdk.getSessionInfo = async (id: string) => {
    calls.push(id);
    return { id, customTitle: 'Booking refund' };
  };
  try {
    assert.equal(typeof actual.claude.info, 'function', 'the shipped module must export the panel title reader');
    assert.deepEqual(await actual.claude.info('native'), { id: 'native', customTitle: 'Booking refund' });
    assert.deepEqual(await actual.call('claude:info', 'native'), { id: 'native', customTitle: 'Booking refund' });
    const live = {
      controller: { ref: () => ({ kind: 'claude', key: 'claude:native', id: 'native' }) },
      chats: { records: new Map([['chat', {}]]) },
    };
    assert.deepEqual(await panelIdentity(live, actual.claude, 'chat'), { title: 'Booking refund' });
    assert.deepEqual(calls, ['native', 'native', 'native']);
    fakes.sdk.getSessionInfo = async () => {
      throw new Error('native metadata unavailable');
    };
    await assert.rejects(actual.claude.info('native'), /native metadata unavailable/);
    await assert.rejects(actual.call('claude:info', 'native'), /native metadata unavailable/);
    assert.deepEqual(await panelIdentity(live, actual.claude, 'chat'), {});
  } finally {
    fakes.sdk.getSessionInfo = before;
    actual.claude.closeAll();
  }
});
