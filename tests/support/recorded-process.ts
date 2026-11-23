// A process fixture advances only after a complete PID publication and its watch's recorded birth.
import assert from 'node:assert/strict';
import { readJsonLineLog } from '../../scripts/fixture-json-log.mjs';

export async function waitForRecordedProcess({
  ready,
  watcher,
  watch,
  now = Date.now,
  wait = () => new Promise<void>((resolve) => setTimeout(resolve, 10)),
  timeout = 5000,
}: {
  ready: string;
  watcher: { tick: () => Promise<unknown> };
  watch: { births: Map<number, string> };
  now?: () => number;
  wait?: () => Promise<void>;
  timeout?: number;
}) {
  const deadline = now() + timeout;
  let pid: number | undefined;
  for (;;) {
    if (pid === undefined) {
      const records = readJsonLineLog(ready);
      if (records.length) {
        const candidate = records[0];
        assert.ok(Number.isSafeInteger(candidate) && candidate > 1, 'the controlled writer publishes a valid PID');
        pid = candidate;
      }
    }
    if (pid !== undefined) {
      await watcher.tick();
      const birth = watch.births.get(pid);
      if (birth) return { pid, birth };
    }
    assert.ok(now() < deadline, 'the controlled writer publishes its recorded identity');
    await wait();
  }
}
