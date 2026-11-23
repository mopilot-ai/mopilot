// Approval identity survives main's publication boundary, native-card normalization and retained-card rendering.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { mockStore, render, resetStore, setStore, impl } from './support/thread-kit.ts';

mockStore();
const { useSourceLabel } = await import('../src/components/thread/approvals/shared.tsx');
const { toRequest } = await import('../src/harness/approvalRequests.ts');
const require = createRequire(import.meta.url);
const { ChatController } = require('../electron/session/controller.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const { toRendererSegment } = require('../electron/platform/chats.cjs');
const chat = 'claude:base';
const labels: Record<string, string> = { codex: 'Codex', claude: 'Claude Code', 'acp:kimi': 'Kimi Code' };

beforeEach(() => {
  resetStore();
  impl['store:chatHarnessLabel'] = () => 'Codex';
});

function Agent({ request }: { request: any }) {
  return useSourceLabel(chat, request.params, request.sourceHarness);
}

test('a retained ACP approval publishes its real kind and labels both card and notification from that source', async () => {
  const segments = [
    { kind: 'claude', nativeId: 'base', start: 0, count: 1 },
    { kind: 'acp:kimi', nativeId: 'native', start: 1, count: 1 },
    { kind: 'codex', nativeId: 'current', start: 2, count: null },
  ];
  const records = new Map([[chat, { id: chat, segments }]]);
  const state = new SessionStore();
  const notifications: string[] = [];
  const controller = new ChatController({
    state,
    chats: { records, record: (id: string) => records.get(id) },
    codex: {},
    claudeTurns: {},
    acpTurns: {},
    labelOf: (kind: string) => labels[kind] ?? kind,
    notify: (_kind: string, _id: string, note: any) => notifications.push(note.title),
  });
  controller.addApproval(chat, {
    id: 'permission',
    method: 'acp/permission',
    params: { toolCall: { title: 'Fake action' }, options: [] },
    source: { kind: 'acp', key: 'acp:kimi:native', privateRouting: 'not public' },
  });
  const published = state.get(chat).approvals[0];
  const request = toRequest(chat, published, '/repo', 0)!;
  setStore({ segments: { [chat]: segments.map(toRendererSegment) } });
  const view = await render(createElement(Agent, { request }));
  try {
    assert.equal(view.host.textContent, 'Kimi Code');
    assert.equal((published as any).sourceHarness, 'acp:kimi');
    assert.equal(Object.hasOwn(published, 'source'), false);
    assert.equal(notifications.at(-1), 'Kimi Code needs your approval');
  } finally {
    await view.unmount();
  }
});

test('host cards retain their explicit harness and legacy cards still resolve native segment ids', async () => {
  setStore({ segments: { [chat]: [{ harness: 'claude', nativeId: chat, start: 0, count: 1 }] } });
  for (const [request, expected] of [
    [{ params: { harness: 'acp:kimi', threadId: chat } }, 'Kimi Code'],
    [{ params: { threadId: chat } }, 'Claude Code'],
    [{ params: {}, sourceHarness: 'codex' }, 'Codex'],
    [{ params: {}, sourceHarness: 'acp:kimi' }, 'Kimi Code'],
    [{ params: {}, sourceHarness: null }, 'The agent'],
  ] as const) {
    const view = await render(createElement(Agent, { request }));
    assert.equal(view.host.textContent, expected);
    await view.unmount();
  }
});

test('admitted harnesses outside the static registry use their label, id fallback or neutral empty label', async () => {
  for (const [basicHarnesses, expected] of [
    [[{ id: 'custom', label: 'Custom Agent' }], 'Custom Agent'],
    [[], 'custom'],
    [[{ id: 'custom', label: '' }], 'The agent'],
  ] as const) {
    setStore({ basicHarnesses });
    const view = await render(createElement(Agent, { request: { params: {}, sourceHarness: 'acp:custom' } }));
    assert.equal(view.host.textContent, expected);
    await view.unmount();
  }
});

test('main publishes an explicit unidentified approval origin without attributing it to the current harness', () => {
  const state = new SessionStore();
  const notes: string[] = [];
  const record = { id: chat, segments: [{ kind: 'codex', nativeId: 'current', start: 0, count: null }] };
  const controller = new ChatController({
    state,
    chats: { records: new Map([[chat, record]]), record: () => record },
    codex: {},
    claudeTurns: {},
    acpTurns: {},
    labelOf: (kind: string) => labels[kind] ?? '',
    notify: (_kind: string, _id: string, note: { title: string }) => notes.push(note.title),
  });
  controller.addApproval(chat, { id: 'unidentified', method: 'permission', params: {}, source: { kind: 'unknown', key: 'opaque' } });
  assert.equal(state.get(chat).approvals[0].sourceHarness, null);
  assert.equal(notes.at(-1), 'The agent needs your approval');
});
