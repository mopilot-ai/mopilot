// The dev host's `run agent` command end to end through the real host wiring (scripts/mobile-dev-host/host.mjs --fake-hosts): one agent on a made-up machine changes in the machine rows.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startHost } from '../scripts/mobile-dev-host/host.mjs';

const scratch = mkdtempSync(path.join(tmpdir(), 'dev-host-agent-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

test('run agent sets an agent missing on studio in the machine rows, and a made-up machine or state outside the list is refused', async () => {
  const host = await startHost({
    dir: scratch,
    advertise: '127.0.0.1',
    bind: '127.0.0.1',
    port: 0,
    out: () => undefined,
    sleep: async () => undefined,
    fakeHosts: true,
  });
  after(() => host.stop());
  const codex = () =>
    host.service
      .host()
      .rows()
      .find((m: any) => m.id === 'ssh:studio')
      .agents.find((a: any) => a.id === 'codex');
  assert.equal(codex().state, 'signin');
  assert.match(await host.scenarios.run('agent', ['studio', 'codex', 'missing']), /codex on studio is missing/);
  assert.deepEqual([codex().state, codex().reason], ['missing', 'Not installed on studio']);
  assert.throws(() => host.scenarios.run('agent', ['nowhere', 'codex', 'missing']), /No made-up machine "nowhere"/);
});
