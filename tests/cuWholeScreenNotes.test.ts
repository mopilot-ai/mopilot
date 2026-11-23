// While a chat controls the whole screen, computer use posts no "is using" banner over what the agent clicks; one "is done using your computer" after.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { rig } = await import('./support/computer-use-setup-rig.ts');

test('a whole-screen hold posts no banner while the agent clicks; one done note after, for the app it acted in', () => {
  const notices: any[] = [];
  const r = rig({ notifyKind: (...a: any[]) => notices.push(a) });
  r.runtime.cu.controlling = 'c';
  r.runtime.cu.app = 'your Mac';
  r.runtime.cu.onActivity('c', { app: 'your Mac', state: 'active' });
  r.runtime.cu.app = 'Notes';
  r.runtime.cu.onActivity('c', { app: 'Notes', state: 'active' });
  assert.equal(notices.length, 0, 'no banner over the screen the agent clicks');
  r.runtime.cu.controlling = null;
  r.runtime.cu.onActivity('c', { app: null, state: 'idle' });
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0][2], {
    title: 'The agent is done using your computer',
    body: '',
    chatTitle: 'The agent is done using your computer',
    group: 'done',
    viewing: true,
  });
});
