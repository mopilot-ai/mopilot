// Codex resolves a connector read to the chat's current segment before sending each request.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { deferred } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { CodexApi } = require('../electron/harness/codexApi.cjs');
const { assertInputCurrent } = require('../electron/session/contract/inputGuard.cjs');

test('keeps the global settings call and rejects an obsolete session before native dispatch', async () => {
  const api = Object.create(CodexApi.prototype);
  let active = 'thread';
  const requests: unknown[][] = [];
  const ready = deferred<void>();
  api.codexThread = (chatId: string) => (chatId === 'chat' ? active : null);
  api.request = async (...args: unknown[]) => {
    requests.push(args);
    await ready.promise;
    assertInputCurrent(args[1]);
    return { data: [], nextCursor: null };
  };
  const scope = { chatId: 'chat', nativeId: active, cursor: 'opaque' };
  const global = api.api('mcpStatus', []);
  const correct = api.api('mcpStatus', [scope]);
  await assert.rejects(api.api('mcpStatus', [{ ...scope, nativeId: '' }]), /session changed/);
  await assert.rejects(api.api('mcpStatus', [{ ...scope, chatId: 'other' }]), /session changed/);
  active = 'new-thread';
  ready.resolve();
  assert.deepEqual(await global, { data: [], nextCursor: null });
  await assert.rejects(correct, /session changed/);
  assert.deepEqual(requests, [
    ['mcpServerStatus/list', {}],
    ['mcpServerStatus/list', { threadId: 'thread', cursor: 'opaque', detail: 'toolsAndAuthOnly' }, { timeoutMs: 10_000 }],
  ]);
  assert.deepEqual(await api.api('mcpStatus', [{ ...scope, nativeId: active }]), { data: [], nextCursor: null });
});
