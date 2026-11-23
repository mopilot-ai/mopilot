// One app-server per credential with real processes (#4667 H3): a stand-in `codex` binary, spawned as a real child for each credential, so what the unit tests show with fake pipes holds for the real thing: each chat's turn reaches the process of its own credential, one process killed leaves the other chat running, and a credential nobody uses keeps no process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createCodexFamily, LANE_IDLE_MS } from '../host/src/codexFamily.mjs';
import { waitFor } from './support/waitFor.ts';

const { SessionStore } = createRequire(import.meta.url)('../electron/session/state.cjs');

/** What the stand-in `codex app-server` does: answers each request, and says which process served it and what it was told. */
const FAKE = `#!${process.execPath}
let told = null;
let n = 0;
let buf = '';
const say = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.id === undefined || !m.method) continue;
    if (m.method === 'account/login/start') told = m.params.apiKey;
    const result =
      m.method === 'thread/start' ? { thread: { id: 'th-' + process.pid + '-' + ++n, cwd: '/w', ephemeral: false } }
      : m.method === 'turn/start' ? { turn: { id: 'turn-' + process.pid }, servedBy: process.pid, store: process.argv.includes('cli_auth_credentials_store="ephemeral"') ? 'ephemeral' : 'own', told }
      : {};
    say({ id: m.id, result });
  }
});
`;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const gone = async (pid: number) => {
  await waitFor(() => !alive(pid), `process ${pid} to end`, { timeoutMs: 3000 }).catch(() => undefined);
  return !alive(pid);
};

test('two credentials run in two real processes: each chat’s turn reaches its own, a killed one leaves the other, and an idle one is reaped', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-'));
  const bin = path.join(dir, 'codex');
  fs.writeFileSync(bin, FAKE, { mode: 0o755 });
  const committed: any[] = [];
  const threadChat = new Map<string, string>();
  const controller: any = {
    chatOf: (id: string) => threadChat.get(id) ?? id,
    requestChat: (id: string) => threadChat.get(id) ?? id,
    isCurrentSource: () => true,
    ref: () => ({ kind: 'codex' }),
    onCodexMessage: () => undefined,
    onCodexExit: () => [],
    codexStopped: () => undefined,
    onCodexOutgoing: () => true,
    invalidate: () => undefined,
  };
  const ctx: any = {
    paths: { dataDir: dir },
    state: new SessionStore(),
    chats: { records: new Map(), get: () => null, patchMeta: () => undefined, commit: (r: any) => !!committed.push(r) },
    controller: () => controller,
    emit: () => undefined,
  };
  const kept = new Map([
    ['keyed', 'key'],
    ['own', 'own'],
  ]);
  const family = createCodexFamily({
    env: { PATH: dir, CODEX_HOME: path.join(dir, 'home') },
    which: () => bin,
    probe: (async () => true) as any,
    leases: { loginKey: () => 'sk-stand-in', orgLease: () => null, onChange: () => undefined } as any,
    credentials: { sourceOf: (chat: string) => (kept.get(chat) as any) ?? null },
  })(ctx);
  const pids = new Set<number>();
  t.after(() => {
    family.close();
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const begin = async (chatId: string) => {
    await family.prepare({ chatId, cwd: dir });
    const nativeId = JSON.stringify(committed.at(-1)).match(/th-\d+-\d+/)![0];
    threadChat.set(nativeId, chatId);
    return nativeId;
  };
  const turn = async (threadId: string) => {
    const r: any = await family.codex.request('turn/start', { threadId, input: [] });
    pids.add(r.servedBy);
    return r;
  };

  const keyed = await begin('keyed');
  const own = await begin('own');
  const a = await turn(keyed);
  const b = await turn(own);
  // two processes, each for its own credential: the lent key told to the one, never to the other
  assert.notEqual(a.servedBy, b.servedBy);
  assert.deepEqual([a.store, a.told], ['ephemeral', 'sk-stand-in']);
  assert.deepEqual([b.store, b.told], ['own', null]);
  assert.equal((await turn(keyed)).servedBy, a.servedBy);
  assert.equal((await turn(own)).servedBy, b.servedBy);

  // the own-login process is killed: the key chat is unaffected, and the next request for the other starts a new process
  process.kill(b.servedBy, 'SIGKILL');
  assert.ok(await gone(b.servedBy));
  assert.equal((await turn(keyed)).servedBy, a.servedBy);
  const again = await turn(own);
  assert.notEqual(again.servedBy, b.servedBy);
  assert.notEqual(again.servedBy, a.servedBy);

  // an idle credential keeps no process; the main one's chats are not touched, and the thread loads again with its next message
  assert.equal(family.reapLanes(Date.now()), 0, 'just used: not idle');
  assert.equal(family.reapLanes(Date.now() + LANE_IDLE_MS + 1_000), 1);
  assert.ok(await gone(again.servedBy));
  assert.ok(alive(a.servedBy));
  const back = await turn(own);
  assert.notEqual(back.servedBy, again.servedBy);
  assert.equal((await turn(keyed)).servedBy, a.servedBy);
});
