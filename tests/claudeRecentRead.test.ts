// The end of a Claude Code transcript read alone (readRecentMessages, turnReads recentTurns): what it gives is the end of what a whole read gives, with the SDK's own reading and what a read puts back, and a read that cannot be the end alone is the whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { uuidOf, writeTranscript } from './support/claudeTranscriptFixture';

const require = createRequire(import.meta.url);
const { createTranscriptReader, launchesLost, compactionIn, entriesStore } = require('../electron/platform/claudeTranscriptRead.cjs');
const { createTranscripts } = require('../electron/harness/claude/transcripts.cjs');
const { allTurns, releaseHistory } = require('../electron/platform/claudeHistory.cjs');
const { withOwnTextIds } = require('../electron/session/peerNativeHistory.cjs');
const sdk = await import('@anthropic-ai/claude-agent-sdk');

const SID = '00000000-0000-4000-8000-0000000000aa';
const TURNS = 160;
const options = { sessionId: SID, turns: TURNS, toolsPerTurn: 2, resultBytes: 600, endTurnAt: [TURNS - 3, 5], noticeAt: [TURNS - 2, 6] };
/** About a fifth of the transcript, so the window starts well inside it. */
const WINDOW = 150_000;
const ignored: string[] = [];
const reader = createTranscriptReader({ noteIgnored: (what: string) => ignored.push(what) });

const fixture = writeTranscript(options);
test.after(() => fixture.done());
const resume = () => undefined;

test('the fixture is larger than the window, so a window is the end alone', () => {
  assert.ok(fixture.size > 3 * WINDOW, `${fixture.size} bytes`);
});

test('the messages of a window are the last messages of the whole read: the SDK reads them alike, and notices and end-turn marks are put back', async () => {
  const whole = await reader.readMessages(sdk, fixture.file, SID, resume);
  const end = await reader.readRecentMessages(sdk, fixture.file, SID, resume, { bytes: WINDOW });
  assert.equal(end.whole, false);
  assert.ok(end.messages.length > 20 && end.messages.length < whole.length / 2, `${end.messages.length} of ${whole.length}`);
  assert.deepEqual(end.messages, whole.slice(-end.messages.length));
  // what the SDK drops and a read puts back is in the end, where the transcript has it
  assert.ok(
    end.messages.some((m: any) => m.type === 'system' && /notice 158/.test(JSON.stringify(m))),
    'the notice of turn 158',
  );
  assert.equal(
    end.messages.filter((m: any) => m.mcpMeta?._meta?.['claude/endTurn']).length,
    1,
    'the end-turn flag of turn 157, and not that of turn 5',
  );
});

test('the turns of a window are the last turns of the whole read, but its first, which lost its start, once their text is numbered by its own message', async () => {
  const read = async (extra: object) => {
    const answer = await reader.readTurnPage(
      { sdk },
      { sessionId: SID, file: fixture.file, chatId: 'chat', cwd: '/work', uncached: true, ...extra },
    );
    try {
      return { turns: await allTurns(answer.read), whole: answer.whole };
    } finally {
      releaseHistory(answer.read);
    }
  };
  const full = await read({});
  const end = await read({ recent: { bytes: WINDOW } });
  assert.equal(end.whole, false);
  assert.ok(end.turns.length > 5 && end.turns.length < full.turns.length / 2, `${end.turns.length} of ${full.turns.length}`);
  // the window's first turn began before it; every turn after it is the whole read's, item for item
  const kept = end.turns.length - 1;
  assert.deepEqual(withOwnTextIds(end.turns.slice(1)), withOwnTextIds(full.turns).slice(-kept));
  // the id a phone names to page before a row is the same whichever window or whole read gave it
  const bigger = await read({ recent: { bytes: 2 * WINDOW } });
  const ids = (turns: any[]) => new Map(turns.flatMap((t) => t.items.map((i: any) => [i.id, t.id] as const)));
  const small = ids(withOwnTextIds(end.turns.slice(1)));
  const large = ids(withOwnTextIds(bigger.turns.slice(1)));
  assert.ok(
    small.size > 20 && [...small].every(([id, turn]) => large.get(id) === turn),
    'every id of the smaller window is in the larger, in the same turn',
  );
  assert.ok(end.turns.at(-1).items.some((item: any) => /reply 159/.test(JSON.stringify(item))));
});

test('the same through the harness: recentTurns, in this thread when no worker is wired', async () => {
  const state = { sdk: async () => sdk, resumeAt: new Map() };
  const transcripts = createTranscripts(state, null);
  const full = await transcripts.allTurns(SID, { cwd: '/work' });
  const end = await transcripts.recentTurns(SID, { cwd: '/work', bytes: WINDOW });
  assert.equal(end.whole, false);
  assert.deepEqual(withOwnTextIds(end.turns.slice(1)), withOwnTextIds(full).slice(-(end.turns.length - 1)));
  const all = await transcripts.recentTurns(SID, { cwd: '/work', bytes: 1e9 });
  assert.equal(all.whole, true, 'a window that holds the file is the whole chat');
  assert.deepEqual(all.turns, full);
});

test('a file that fits the window is read whole, as readMessages reads it', async () => {
  const end = await reader.readRecentMessages(sdk, fixture.file, SID, resume, { bytes: fixture.size });
  assert.equal(end.whole, true);
  assert.deepEqual(end.messages, await reader.readMessages(sdk, fixture.file, SID, resume));
});

test('a line the CLI is still writing at the end is left out, and so is the line a window starts in', async () => {
  const copy = writeTranscript({ ...options, sessionId: '00000000-0000-4000-8000-0000000000ab', turns: 40 });
  try {
    fs.appendFileSync(copy.file, '{"type":"assistant","uuid":"half","message":{"content":[{"type":"te');
    const whole = await reader.readMessages(sdk, copy.file, '00000000-0000-4000-8000-0000000000ab', resume);
    for (const bytes of [30_001, 30_002, 30_003, 30_004, 30_005]) {
      const end = await reader.readRecentMessages(sdk, copy.file, '00000000-0000-4000-8000-0000000000ab', resume, { bytes });
      assert.equal(end.whole, false);
      assert.ok(end.messages.length > 3);
      assert.deepEqual(end.messages, whole.slice(-end.messages.length), `${bytes} bytes`);
    }
  } finally {
    copy.done();
    process.env.CLAUDE_CONFIG_DIR = fixture.dir;
  }
});

test('an SDK that cannot read from a store, and a chat with no file, are answered with the whole read', async () => {
  const messages = await reader.readMessages(sdk, fixture.file, SID, resume);
  const before = ignored.length;
  const noStore = {
    getSessionMessages: async (id: string, o: any) => {
      if (o?.sessionStore) throw new Error('no stores here');
      return sdk.getSessionMessages(id, o);
    },
  };
  const end = await reader.readRecentMessages(noStore, fixture.file, SID, resume, { bytes: WINDOW });
  assert.equal(end.whole, true);
  assert.deepEqual(end.messages, messages);
  assert.deepEqual(ignored.slice(before), ['read the end of a Claude Code transcript through the SDK']);
  const none = await reader.readRecentMessages({ getSessionMessages: async () => [] }, null, SID, resume, { bytes: WINDOW });
  assert.deepEqual(none, { messages: [], whole: true, dangling: false, compacted: false });
});

test('an end that cannot be read is noted, and the whole read answers it, with its own failure when that fails too', async () => {
  const before = ignored.length;
  const missing = `${fixture.dir}/projects/-work/none.jsonl`;
  await assert.rejects(reader.readRecentMessages({ getSessionMessages: async () => [] }, missing, SID, resume, { bytes: 100 }), /ENOENT/);
  assert.deepEqual(ignored.slice(before), ['read the end of a Claude Code transcript']);
});

test('a cutoff (an edited message not yet sent again) cuts the end as it cuts the whole read', async () => {
  // a message of turn 150, which the window holds: turns have 6 lines, and turn 6 has a notice
  const cutoff = uuidOf(150 * 6 + 2 + 1);
  const whole = await reader.readMessages(sdk, fixture.file, SID, () => cutoff);
  const end = await reader.readRecentMessages(sdk, fixture.file, SID, () => cutoff, { bytes: WINDOW });
  assert.equal(end.whole, false);
  assert.equal(end.messages.at(-1).uuid, cutoff);
  assert.ok(end.messages.length > 10);
  assert.deepEqual(end.messages, whole.slice(-end.messages.length));
});

test('an end that holds a background task notification without the call that launched it is dangling, and one that holds both is not', async () => {
  const sid = '00000000-0000-4000-8000-0000000000ad';
  const dangling = async (notifications: { turn: number; launchedAt: number; via?: 'text' | 'system' }[]) => {
    const copy = writeTranscript({ sessionId: sid, turns: 80, resultBytes: 600, notifications });
    try {
      assert.ok(copy.size > 300_000, 'the window holds only the last turns');
      return (await reader.readRecentMessages(sdk, copy.file, sid, resume, { bytes: 100_000 })).dangling;
    } finally {
      copy.done();
      process.env.CLAUDE_CONFIG_DIR = fixture.dir;
    }
  };
  assert.equal(await dangling([]), false, 'no notification');
  for (const via of ['text', 'system'] as const) {
    assert.equal(await dangling([{ turn: 77, launchedAt: 75, via }]), false, `${via}: the launch is in the window`);
    assert.equal(await dangling([{ turn: 77, launchedAt: 3, via }]), true, `${via}: the launch is before the window`);
  }
  // one launched in the window and one that was not: the end is dangling
  assert.equal(
    await dangling([
      { turn: 77, launchedAt: 75 },
      { turn: 78, launchedAt: 3 },
    ]),
    true,
  );
  const whole = await reader.readRecentMessages(sdk, fixture.file, SID, resume, { bytes: 1e9 });
  assert.equal(whole.dangling, false, 'a whole read has every launch');
});

test('text is numbered by its own message: the same message has the same id in a read of any start', () => {
  const turn = (ids: string[]) => ({ id: 't', items: ids.map((id) => ({ id })) });
  // a whole read numbers by what it has seen; the end of it starts again
  const whole = withOwnTextIds([turn(['m1:t0', 'x', 'm1:t1', 'm2:r2']), turn(['m3:t3', 'm1:t4'])]);
  const end = withOwnTextIds([turn(['m3:t0', 'm1:t1'])]);
  assert.deepEqual(
    whole.map((t: any) => t.items.map((i: any) => i.id)),
    [
      ['m1:t0', 'x', 'm1:t1', 'm2:r0'],
      ['m3:t0', 'm1:t2'],
    ],
  );
  assert.deepEqual(
    end[0].items.map((i: any) => i.id),
    ['m3:t0', 'm1:t0'],
  );
  // an item with no such id, and a turn with no items, are left as they are
  assert.deepEqual(withOwnTextIds([{ id: 'u', items: [{ id: 5 }, { type: 'x' }] }, { id: 'v' }]), [
    { id: 'u', items: [{ id: 5 }, { type: 'x' }] },
    { id: 'v', items: [] },
  ]);
});

test('the lines of a launch and its notification, in every shape the CLI and the SDK write them', async () => {
  const launch = (id: string) => ({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'on it' },
        { type: 'tool_use', id, name: 'Bash', input: {} },
      ],
    },
  });
  const note = (id: string) => `<task-notification>\n<task-id>bg</task-id>\n<tool-use-id>${id}</tool-use-id>\n</task-notification>`;
  // the notification as one string, as text blocks among others, and as the SDK's system message
  assert.equal(launchesLost([launch('t1'), { type: 'user', message: { content: note('t1') } }]), false);
  assert.equal(launchesLost([{ type: 'user', message: { content: note('t1') } }]), true);
  assert.equal(
    launchesLost([launch('t1'), { type: 'user', message: { content: [{ type: 'image' }, { type: 'text', text: note('t1') }] } }]),
    false,
  );
  assert.equal(launchesLost([{ type: 'user', message: { content: [{ type: 'image' }, { type: 'text', text: note('t1') }] } }]), true);
  assert.equal(launchesLost([launch('t1'), { type: 'system', subtype: 'task_notification', tool_use_id: 't1' }]), false);
  assert.equal(launchesLost([{ type: 'system', subtype: 'task_notification', tool_use_id: 't1' }]), true);
  // lines that are no notification, or name no call, lose no launch
  assert.equal(
    launchesLost([
      { type: 'system', subtype: 'task_notification' },
      { type: 'system', subtype: 'other', tool_use_id: 'x' },
    ]),
    false,
  );
  assert.equal(
    launchesLost([{ type: 'user', message: { content: '<task-notification>\n<task-id>bg</task-id>\n</task-notification>' } }]),
    false,
    'no tool use named',
  );
  assert.equal(
    launchesLost([
      { type: 'user', message: { content: [{ type: 'text', text: 'hello' }, null] } },
      { type: 'user', message: { content: 7 } },
      { type: 'user' },
      null,
    ]),
    false,
  );
  assert.equal(
    launchesLost([
      { type: 'assistant', message: { content: 'plain' } },
      { type: 'assistant', message: { content: [null, { type: 'tool_use', id: 7 }] } },
    ]),
    false,
  );
  assert.equal(launchesLost([]), false);
});

test('the store the SDK reads the end from holds the lines and takes no writes', async () => {
  const entries = [{ type: 'user', uuid: 'a' }];
  const store = entriesStore(entries);
  assert.equal(await store.load({ projectKey: 'p', sessionId: 's' }), entries);
  assert.equal(await store.append({ projectKey: 'p', sessionId: 's' }, [{ type: 'x' }]), undefined);
  assert.deepEqual(entries, [{ type: 'user', uuid: 'a' }]);
});

test('an edit not yet sent again that lies before the end is cut by the whole read, which the end read leaves to it', async () => {
  // a message of turn 20, long before the window: the whole read stops there, and so must the answer
  const cutoff = uuidOf(20 * 6 + 2);
  const whole = await reader.readMessages(sdk, fixture.file, SID, () => cutoff);
  const end = await reader.readRecentMessages(sdk, fixture.file, SID, () => cutoff, { bytes: WINDOW });
  assert.equal(end.whole, true);
  assert.equal(end.messages.at(-1).uuid, cutoff);
  assert.deepEqual(end.messages, whole);
  // the same by a string, and a cutoff no message has is cut by neither
  const byString = await reader.readRecentMessages(sdk, fixture.file, SID, cutoff, { bytes: WINDOW });
  assert.equal(byString.whole, true);
  const nowhere = await reader.readRecentMessages(sdk, fixture.file, SID, 'no such message', { bytes: WINDOW });
  assert.equal(nowhere.whole, true, 'asked for a cutoff the end does not hold, the whole read answers (and finds none)');
});

test('an end that holds a compaction says so, and one that does not, does not', async () => {
  const sid = '00000000-0000-4000-8000-0000000000ae';
  const compacted = async (compactAt: number[]) => {
    const copy = writeTranscript({ sessionId: sid, turns: 80, resultBytes: 600, compactAt });
    try {
      const end = await reader.readRecentMessages(sdk, copy.file, sid, resume, { bytes: 100_000 });
      assert.equal(end.whole, false);
      return end.compacted;
    } finally {
      copy.done();
      process.env.CLAUDE_CONFIG_DIR = fixture.dir;
    }
  };
  assert.equal(await compacted([]), false);
  assert.equal(await compacted([77]), true, 'a compaction in the last turns');
  assert.equal(await compacted([5]), false, 'a compaction long before the window');
  assert.equal(compactionIn([{ type: 'user', isCompactSummary: true }]), true, 'the summary after a boundary');
  assert.equal(compactionIn([{ type: 'system', subtype: 'informational' }, { type: 'user' }, null]), false);
  assert.equal(compactionIn([]), false);
  assert.equal((await reader.readRecentMessages(sdk, fixture.file, SID, resume, { bytes: 1e9 })).compacted, false, 'a whole read');
});
