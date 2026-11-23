// What the agent is told when the Host's browser cannot be reached or refuses (electron/capabilities/browser/remoteHost.cjs asToolErrors, package 2.6): a ToolError that keeps the Host's code, an unreachable Host being `not_connected`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { world } from './support/remote-tabs-kit.ts';

const require = createRequire(import.meta.url);
const { ToolError } = require('../electron/capabilities/contract/registry.cjs');

const failing = (error: unknown) => (base: any) => ({
  ...base,
  open: () => Promise.reject(error),
});

test('a Host that cannot be reached is not_connected; another code is kept; a failure with none is failed', async (t) => {
  const cases: [unknown, string, RegExp][] = [
    [Object.assign(new Error('The host is unreachable: tunnel offline'), { code: 'host_unreachable' }), 'not_connected', /unreachable/],
    [Object.assign(new Error('no Chrome'), { code: 'no_chromium' }), 'no_chromium', /no Chrome/],
    [new Error('plain'), 'failed', /plain/],
    ['text only', 'failed', /text only/],
    [new ToolError('already a tool error', 'bad_args'), 'bad_args', /already/],
  ];
  for (const [error, code, message] of cases) {
    const w = world(t, { transport: failing(error) });
    await assert.rejects(w.tabs.create('c'), (e: any) => e instanceof ToolError && e.code === code && message.test(e.message));
  }
});
