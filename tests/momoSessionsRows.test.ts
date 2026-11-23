// What MoMo's Sessions pane lists (src/components/momo/sessions/sessionRows.ts, M6): each of the chat's shared states in the design's group, the chats with nothing open left out, the list order kept, where a chat runs said the same for this Mac, a machine and an offline machine, and the same grouping for Claude Code, Codex and basic-harness chats (it reads the one status, never a harness).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byGroup, groupOf, GROUP_TITLE, SESSION_GROUPS, sessionRows } from '../src/components/momo/sessions/sessionRows.ts';
import { EMPTY_SESSION } from '../src/store/session/sessionState.ts';
import type { ChatRowState } from '../src/session/chatRowState.ts';

test('every state has one group, or none when nothing is open', () => {
  const table: [ChatRowState, string | null][] = [
    ['approval', 'needs'],
    ['input', 'needs'],
    ['working', 'working'],
    ['elsewhereRunning', 'working'],
    ['error', 'wait'],
    ['failed', 'wait'],
    ['unread', 'wait'],
    ['done', 'wait'],
    ['elsewhere', null],
    ['idle', null],
  ];
  for (const [state, group] of table) assert.equal(groupOf(state), group, state);
  assert.deepEqual(Object.keys(GROUP_TITLE), [...SESSION_GROUPS]);
});

const base = { adapterTasks: [], elsewhere: undefined, unread: false, requests: [], runtime: undefined };
const chat = (id: string) => ({ id, cwd: '/repo', status: { type: 'idle' } }) as any;

test('rows keep the list order, drop chats with nothing open and chats the store does not know, and say where each runs', () => {
  const inputs: Record<string, any> = {
    // a waiting card on a Claude Code key, a running turn on a Codex id, a basic harness chat that finished unseen
    'claude:a': { ...base, thread: chat('claude:a'), session: { ...EMPTY_SESSION, rev: 1, turn: 'awaitingUser' } },
    'codex-b': { ...base, thread: chat('codex-b'), session: { ...EMPTY_SESSION, rev: 1, turn: 'running' } },
    'acp:kimi:c': { ...base, thread: chat('acp:kimi:c'), session: undefined, unread: true },
    idle: { ...base, thread: chat('idle'), session: undefined },
  };
  const rows = sessionRows({
    ids: ['claude:a', 'idle', 'gone', 'codex-b', 'acp:kimi:c'],
    inputs: (id) => inputs[id] ?? null,
    title: (id) => `Title ${id}`,
    harness: (id) => (id.startsWith('claude') ? 'Claude Code' : id.startsWith('codex') ? 'Codex' : 'Kimi Code'),
    place: (id) => (id === 'codex-b' ? { name: 'Studio', away: false } : id === 'acp:kimi:c' ? { name: 'Laptop', away: true } : null),
  });
  assert.deepEqual(
    rows.map((r) => [r.id, r.group, r.harness, r.where]),
    [
      ['claude:a', 'needs', 'Claude Code', 'This Mac'],
      ['codex-b', 'working', 'Codex', 'Studio'],
      ['acp:kimi:c', 'wait', 'Kimi Code', 'Laptop · away'],
    ],
  );
  assert.equal(rows[0].title, 'Title claude:a');
});

test('groups come in the design’s order and an empty group is left out', () => {
  const row = (id: string, group: any) => ({ id, title: id, group, harness: 'h', where: 'w' });
  const groups = byGroup([row('w1', 'wait'), row('n1', 'needs'), row('w2', 'wait')]);
  assert.deepEqual(
    groups.map((g) => [g.group, g.rows.map((r) => r.id)]),
    [
      ['needs', ['n1']],
      ['wait', ['w1', 'w2']],
    ],
  );
  assert.deepEqual(byGroup([]), []);
});
