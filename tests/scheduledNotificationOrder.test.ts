// Scheduled journeys follow their chat's notification even when an approval outranks the start notice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { latestChatNotification } from './e2e/fixtures/notificationTarget.ts';
const require = createRequire(import.meta.url);
const { Notifier } = require('../electron/platform/notify.cjs');

for (const urgent of ['approval', 'auth']) {
  for (const first of ['scheduled', urgent]) {
    test(`${first} first: ${urgent} remains actionable and the scheduled chat owns the selected notification`, () => {
      const shown: { groupId: string; body: string; title: string }[] = [];
      const n = new Notifier({
        getMode: () => 'always',
        show: (note: { groupId: string; body: string; title: string }) => {
          shown.push(note);
          return { close() {} };
        },
      });
      const scheduled = () => n.notify('scheduled', 'run', { title: 'Scheduled task started', body: 'Nightly check' });
      const needed = () => n.notify(urgent, 'run', { title: 'Needs you', body: 'Task prompt' });
      if (first === 'scheduled') {
        scheduled();
        needed();
      } else {
        needed();
        assert.equal(scheduled(), null);
      }
      assert.equal(
        shown.some((note) => note.body === 'Nightly check'),
        first === 'scheduled',
      );
      // An unrelated late notification cannot redirect the click, even with the exact old task-name body.
      shown.push({ groupId: 'other-chat', title: 'Scheduled task started', body: 'Nightly check' });
      const picked = latestChatNotification(shown, 'run');
      assert.ok(picked >= 0);
      assert.equal(shown[picked].groupId, 'run');
      assert.equal(shown[picked].title, 'Needs you');
    });
  }
}

test('missing or empty chat identity never falls back to a different notification', () => {
  assert.equal(latestChatNotification([], 'run'), -1);
  assert.equal(latestChatNotification([{} as any, { groupId: 'merged' }], 'run'), -1);
  assert.equal(latestChatNotification([{ groupId: 'other' }], 'run'), -1);
  assert.equal(latestChatNotification([{ groupId: '' }], ''), -1);
});

test('latest captured matching owner wins over older same-chat notices', () => {
  assert.equal(latestChatNotification([{ groupId: 'run' }, { groupId: 'other' }, { groupId: 'run' }], 'run'), 2);
});

test('chat publication does not establish the scheduled mark before asynchronous startup returns', async () => {
  const { AutomationRunner } = require('../electron/platform/automationRun.cjs');
  const { SessionStore } = require('../electron/session/state.cjs');
  const sessions = new SessionStore();
  let release!: () => void;
  let published!: () => void;
  const announced = new Promise<void>((resolve) => {
    published = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runner = new AutomationRunner({
    usable: async () => true,
    sessions,
    send: async () => ({ started: true }),
  });
  runner.startChat = async () => {
    published();
    await gate;
    return 'run';
  };
  const pending = runner.run({ kind: 'cron', harness: 'claude', computer_control: true, on_approval: 'wait' }, { unattended: true });
  await announced;
  assert.equal(sessions.get('run').scheduled, null);
  release();
  await pending;
  assert.deepEqual(sessions.get('run').scheduled, { unattended: true, computer: true, onApproval: 'wait' });
});
