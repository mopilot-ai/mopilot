// A refused message carried to a new chat on its machine (src/session/refusalNewChat.ts): same folder and agent, the words in its composer unsent; nothing is carried when no chat could start.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const started: unknown[] = [];
const drafts: unknown[][] = [];
let id: string | null = 'new-chat';
let threads: Record<string, { cwd?: string }> = { old: { cwd: '/srv/proj' } };
mock.module('../src/store/core.ts', { namedExports: { get: () => ({ threads }), setDraft: (...a: unknown[]) => void drafts.push(a) } });
mock.module('../src/store/send.ts', {
  namedExports: { createHostChatThread: async (host: unknown) => (started.push(host), id) },
});
const { newChatWithMessage } = await import('../src/session/refusalNewChat.ts');

const refusal = { code: 'chat_unknown', action: 'newChat', retry: false, hostId: 'box', machine: 'mini', agent: 'codex' } as any;
const message = { chatId: 'old', text: 'carry me', attachments: [{ kind: 'image' }] } as any;

test('the new chat is on the same machine, in the chat’s folder, on its agent, and holds the message as a draft', async () => {
  assert.equal(await newChatWithMessage(refusal, message), true);
  assert.deepEqual(started, [{ id: 'box', name: 'mini', path: '/srv/proj', agent: 'codex' }]);
  assert.deepEqual(drafts, [['new-chat', { text: 'carry me', attachments: [{ kind: 'image' }] }]]);
});

test('no chat started (it told why): nothing is drafted; a chat with no known folder or agent is asked for them by the creator', async () => {
  started.length = 0;
  drafts.length = 0;
  id = null;
  assert.equal(await newChatWithMessage(refusal, message), false);
  assert.deepEqual(drafts, []);
  threads = {};
  await newChatWithMessage({ ...refusal, agent: undefined }, message);
  assert.deepEqual(started.pop(), { id: 'box', name: 'mini', path: '' });
});

test('a folder chosen for it replaces the chat\u2019s own', async () => {
  started.length = 0;
  drafts.length = 0;
  id = 'chosen';
  threads = { old: { cwd: '/srv/proj' } };
  assert.equal(await newChatWithMessage(refusal, message, '/srv/other'), true);
  assert.deepEqual(started, [{ id: 'box', name: 'mini', path: '/srv/other', agent: 'codex' }]);
  assert.deepEqual(drafts, [['chosen', { text: 'carry me', attachments: [{ kind: 'image' }] }]]);
});
