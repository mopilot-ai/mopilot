// An organization lease for ACP agents on a Host (host/src/acp.mjs createAcpRuntime, electron/harness/acp.cjs restartAgents): the lease is in the env an agent starts with; a lease that changes restarts the agents between turns, never in one; another identity's message while a turn runs is refused, never sent through the running agent.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { ACP_IDENTITY_BUSY, createAcpRuntime } from '../host/src/acp.mjs';
import { createCredentialLeases } from '../host/src/credentialLease.mjs';
import { createPaths } from '../host/src/paths.mjs';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-org-acp-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const GW = { anthropic: 'https://llm.example.test/anthropic', openai: 'https://llm.example.test/openai/v1' };
const lease = (identity: string, token: string) => ({ harness: 'acp', identity, token, gateways: GW, expiresAt: Date.now() + 3_600_000 });

test('W: the lease is in a new agent’s env; a change restarts the agents once idle; another identity’s message mid-turn is refused', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'd-'));
  const leases = createCredentialLeases();
  const runtime = createAcpRuntime({ paths: createPaths({ dataDir: dir, env: {} }), env: { KEEP: '1' }, leases });
  const restarts: number[] = [];
  const closeAll = runtime.host.closeAll.bind(runtime.host);
  runtime.host.closeAll = (only?: boolean) => (only ? void restarts.push(1) : closeAll());
  let turn = 0;
  runtime.host.send = async () => ({ turnId: `t${++turn}` });
  try {
    assert.deepEqual(runtime.host.envOf(), { KEEP: '1' }, 'no lease: the Host env as it is');
    leases.setOrg(lease('a'.repeat(32), 'eyJ.dummy-org-token-alice-0000.sig'), Date.now());
    assert.deepEqual(restarts, [1], 'nothing runs: restarted at once');
    const env = runtime.host.envOf();
    assert.deepEqual(env, {
      KEEP: '1',
      ANTHROPIC_BASE_URL: GW.anthropic,
      ANTHROPIC_AUTH_TOKEN: 'eyJ.dummy-org-token-alice-0000.sig',
      OPENAI_BASE_URL: GW.openai,
      OPENAI_API_KEY: 'eyJ.dummy-org-token-alice-0000.sig',
    });
    // A's turn runs
    runtime.host.emit('event', { kind: 'turnStart', turnId: 'run', key: 'acp:fake:a' });
    leases.setOrg(lease('a'.repeat(32), 'eyJ.dummy-org-token-alice-1111.sig'), Date.now());
    assert.deepEqual(restarts, [1], 'a renewal mid-turn waits for the turn to end');
    await runtime.send({ key: 'acp:fake:a', text: 'more' });
    leases.setOrg(lease('b'.repeat(32), 'eyJ.dummy-org-token-bobby-0000.sig'), Date.now());
    await assert.rejects(
      runtime.send({ key: 'acp:fake:b', text: 'hi' }),
      (e: any) => e.code === 'org_identity_busy' && e.message === ACP_IDENTITY_BUSY,
    );
    runtime.host.emit('event', { kind: 'turnEnd', turnId: 'run', stopReason: 'end_turn' });
    await runtime.send({ key: 'acp:fake:b', text: 'hi' });
    assert.deepEqual(restarts, [1, 1], 'restarted between turns, before B’s message');
    assert.equal(runtime.host.envOf().OPENAI_API_KEY, 'eyJ.dummy-org-token-bobby-0000.sig');
    await runtime.send({ key: 'acp:fake:b', text: 'again' });
    assert.deepEqual(restarts, [1, 1], 'once');
    // another harness's lease is not the agents' business
    leases.setOrg({ ...lease('a'.repeat(32), 'eyJ.dummy-org-token-alice-0000.sig'), harness: 'claude' }, Date.now());
    assert.deepEqual(restarts, [1, 1]);
  } finally {
    runtime.close();
  }
});

test('the AcpHost restarts its agents without ending its transcript writer; a full closeAll does both', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'h-'));
  const runtime = createAcpRuntime({ paths: createPaths({ dataDir: dir, env: {} }), env: {} });
  const host: any = runtime.host;
  const killed: string[] = [];
  let stops = 0;
  host.stopWriteErrors = () => stops++;
  host.agents.set('x', Promise.resolve({ kill: () => killed.push('x') }));
  host.isolatedAgents.set('y', Promise.reject(new Error('never started')));
  host.closeAll(true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([killed, stops, host.agents.size, host.isolatedAgents.size], [['x'], 0, 0, 0]);
  host.closeAll();
  assert.equal(stops, 1);
  runtime.close();
});
