// Keeps repair monitor ownership at the production IPC and native follow-up boundary without changing ordinary bindings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSegment } from './support/controller/fixture.ts';
import { prMonitorFixture } from './support/pr-monitor-fixture.ts';
const url = 'https://github.com/o/r/pull/1';
test('repair-owned monitoring tags follow-ups, while an ordinary reconfiguration retires that ownership', async () => {
  const f = prMonitorFixture();
  try {
    selectSegment(f.controller, f.chats, 'worker', [['codex', 'native']]);
    const inputs: any[] = [];
    f.live.mainRepair = { api: { monitorOwner: () => 'reservation', monitorInput: (...args: any[]) => inputs.push(args) } };
    const ctx = { chatId: 'worker', segmentId: f.controller.ref('worker').key };
    f.tools.get('set_pr_monitor').handler({ url, autoFix: true }, ctx);
    assert.equal(f.monitor.snapshot('worker').owner, 'reservation');
    await f.monitor.refresh('worker');
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0][2], 'reservation');
    assert.equal(inputs[0][1].id, f.execs[0].item.id);
    f.handlers.get('prMonitor:configure')({ sender: f.sender }, 'worker', { autoFix: false });
    assert.equal(f.monitor.snapshot('worker').owner, null);
    f.live.mainRepair = {};
    f.tools.get('set_pr_monitor').handler({ url, autoFix: false }, ctx);
    assert.equal(f.monitor.snapshot('worker').owner, undefined);
  } finally {
    f.cleanup();
  }
});
