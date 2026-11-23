// The sidebar PR badge's replies outlive the app: a chat whose replies main saved at its history version is not read
// again at launch, what a history read finds is saved while it is still the chat's latest, and a store that fails only
// costs the read it would have saved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { savedReplies, type RepliesStore } from '../src/lib/threadPullRequest.ts';

const reply = (text: string) => ({ status: 'completed', items: [{ type: 'agentMessage', text }] });
const key = (version: string) => JSON.stringify([3, version]);
const settle = () => new Promise((r) => setImmediate(r));

/** A store over a map, which counts its calls and can be made to fail. */
function memoryStore() {
  const saved = new Map<string, unknown>();
  const calls = { get: [] as string[], put: [] as string[] };
  const fail = { get: false, put: false };
  const store: RepliesStore = {
    get: async (id, version) => {
      calls.get.push(`${id}@${version}`);
      if (fail.get) throw new Error('store unavailable');
      return (saved.get(`${id}@${version}`) as any) ?? null;
    },
    put: async (id, version, replies) => {
      calls.put.push(`${id}@${version}`);
      if (fail.put) throw new Error('disk full');
      saved.set(`${id}@${version}`, replies);
    },
  };
  return { store, saved, calls, fail };
}

test('a chat saved at its version is not read; one that is not is read once and saved under the replies format', async () => {
  const reads: string[] = [];
  const { store, saved, calls } = memoryStore();
  saved.set(`a@${key('1')}`, [reply('Opened PR #7.')]);
  const replies = savedReplies(async (id) => (reads.push(id), [reply(`Opened PR #9 for ${id}.`), reply('Ran the tests.')]), { store });
  assert.deepEqual(await replies('a', '1'), [reply('Opened PR #7.')]);
  assert.deepEqual(reads, [], 'a saved chat reads no history');
  assert.deepEqual(await replies('b', '1'), [reply('Opened PR #9 for b.')]);
  await settle();
  assert.deepEqual(reads, ['b']);
  assert.deepEqual(calls.put, [`b@${key('1')}`], 'only the history read is saved, trimmed to its PR replies');
  assert.deepEqual(saved.get(`b@${key('1')}`), [reply('Opened PR #9 for b.')]);
  // the minute's refresh reuses what it holds, asking the store nothing
  await replies('b', '1');
  assert.equal(calls.get.length, 2);
  // an unversioned read never touches the store
  await replies('c');
  assert.equal(calls.get.length, 2);
});

test('a store that cannot answer or save costs only the read it would have saved', async (t) => {
  const noted = t.mock.method(console, 'debug', () => {});
  const reads: string[] = [];
  const { store, fail, calls } = memoryStore();
  fail.get = true;
  fail.put = true;
  const replies = savedReplies(async (id) => (reads.push(id), [reply('Merged PR #3.')]), { store });
  assert.deepEqual(await replies('a', '1'), [reply('Merged PR #3.')]);
  await settle();
  assert.deepEqual(reads, ['a']);
  assert.deepEqual(calls.put, [`a@${key('1')}`]);
  const said = noted.mock.calls.map((c) => String(c.arguments.join(' ')));
  assert.ok(said.some((m) => m.includes("look up a chat's saved PR replies")));
  assert.ok(said.some((m) => m.includes("save a chat's PR replies")));
});

test('an older saved-replies format is refreshed once to recover the reply timestamp', async () => {
  const { store, saved, calls } = memoryStore();
  saved.set(`chat@${JSON.stringify([2, 'v1'])}`, [reply('Opened PR #5390.')]);
  const dated = { ...reply('Opened PR #5390.'), completedAt: 1795251234 };
  const replies = savedReplies(async () => [dated], { store });
  assert.deepEqual(await replies('chat', 'v1'), [dated]);
  await settle();
  assert.deepEqual(await replies('chat', 'v1'), [dated]);
  assert.deepEqual(calls.get, [`chat@${key('v1')}`]);
  assert.deepEqual(calls.put, [`chat@${key('v1')}`]);
});

test('a failed read saves nothing, and an older read finishing after a newer version saves nothing', async () => {
  const { store, calls } = memoryStore();
  const gates = new Map<string, { ok: () => void; fail: () => void }>();
  const replies = savedReplies(
    (id) =>
      new Promise((resolve, reject) => {
        gates.set(id + gates.size, { ok: () => resolve([reply(`Opened PR #1 in ${id}.`)]), fail: () => reject(new Error('gone')) });
      }),
    { store, slots: 2 },
  );
  const failing = replies('x', '1');
  await settle();
  gates.get('x0')!.fail();
  await assert.rejects(failing, /gone/);
  await settle();
  assert.deepEqual(calls.put, []);
  // the chat changes while its older version is still being read: only the newer version is saved
  const older = replies('y', '1');
  await settle();
  const newer = replies('y', '2');
  await settle();
  gates.get('y2')!.ok();
  await newer;
  gates.get('y1')!.ok();
  await older;
  await settle();
  assert.deepEqual(calls.put, [`y@${key('2')}`]);
});

test("a read still queued when a newer version replaced it takes that version's replies and saves nothing of its own", async () => {
  const { store, calls } = memoryStore();
  const reads: string[] = [];
  let release!: () => void;
  const replies = savedReplies(
    async (id) => {
      reads.push(id);
      if (id === 'busy') await new Promise<void>((r) => (release = r));
      return [reply(`Opened PR #2 for ${id}.`)];
    },
    { store, slots: 1 },
  );
  const busy = replies('busy', '1');
  await settle();
  const queued = replies('z', '1');
  await settle();
  const newer = replies('z', '2');
  await settle();
  release();
  await busy;
  assert.deepEqual(await queued, await newer);
  await settle();
  assert.deepEqual(reads, ['busy', 'z']);
  assert.deepEqual(calls.put.sort(), [`busy@${key('1')}`, `z@${key('2')}`]);
});
