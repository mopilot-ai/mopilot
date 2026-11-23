// The read of a chat's controls after a pick is one request, not two (#4986 F3): this Mac's list of agents is reused for a minute, never for a chat on a machine, and asked again when it is old.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scripted } from './support/phone/m3';
import './support/phone/register.ts';
const controlsPath = '../mobile/src/remote/controls';
const clientPath = '../mobile/src/remote/client';
const { loadChatControls, AGENTS_FRESH_MS } = await import(controlsPath);
const { ownedRequest } = await import(clientPath);

const reply = {
  models: [],
  model: null,
  effort: null,
  harnessId: 'claude',
  harness: 'Claude Code',
  permission: { value: 'default', rows: [] },
};
const mac = () =>
  scripted((method) => {
    if (method === 'machine.hello') return { capabilities: { methods: ['options.get', 'chat.switch'], permissionCeiling: 'auto-review' } };
    if (method === 'options.get') return reply;
    if (method === 'harnesses.list') return { harnesses: [{ id: 'codex', label: 'Codex' }] };
    return undefined;
  });
const asked = (calls: [string, unknown][]) => calls.filter(([m]) => m === 'harnesses.list').length;

test('agents read a moment ago are reused: one options.get and no harnesses.list', async () => {
  const m = mac();
  const request = ownedRequest(m.runtime);
  const first = await loadChatControls(request, 'c');
  assert.equal(asked(m.calls), 1);
  const again = await loadChatControls(request, 'c', { harnesses: first.harnesses, at: Date.now() });
  assert.equal(asked(m.calls), 1, 'not asked again');
  assert.deepEqual(again.harnesses, [{ id: 'codex', label: 'Codex' }]);
});

test('agents read long ago are asked for again', async () => {
  const m = mac();
  const request = ownedRequest(m.runtime);
  await loadChatControls(request, 'c', { harnesses: [], at: Date.now() - AGENTS_FRESH_MS - 1 });
  assert.equal(asked(m.calls), 1);
});
