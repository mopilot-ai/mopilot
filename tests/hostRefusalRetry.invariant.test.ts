// Retry is offered only where the Host would take the same message again: the table's `retry` (shared/host/refusalWords.mjs) and the Host ledger's "refused before anything was done" list (host/src/ledger.mjs NOT_DONE) say the same, and the ledger really does run a request again for each code on it and replay the refusal for any other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM
import { REFUSAL_CODES, refusalWords } from '../shared/host/refusalWords.mjs';
// @ts-ignore
import { NOT_DONE, createLedger } from '../host/src/ledger.mjs';

/** Codes the table allows Retry for that never reach the Host's ledger: this app's own gate or service, and reads. */
const NOT_LEDGERED = new Set([
  'org_unavailable',
  'feature_missing',
  'version_refused',
  'read_timed_out',
  'history_changed',
  'key_unreadable',
  // MoMo's guard and wire methods: raised by the chat veil before the ledger sees a message (the same key is asked again from scratch), or by `host.momoMove`/`host.momoChat`, which are not chat writes
  'momo_home_away',
  'momo_grant_lapsed',
  // MoMo's home reaching another machine (host/src/momoTasks/homeClient.mjs): `machine_offline` is raised before any request is sent, so nothing was taken; `machine_lost` after one was sent, and the retry sends the same chat id and wire key (remoteMachine keeps the start key), which the target's ledger answers as a repeat of that request. Neither is a refusal the ledger stored, so neither is ever answered again as a refusal.
  'machine_offline',
  'machine_lost',
  'turn_busy',
  'momo_chat_not_started',
  'home_lease_stale',
  'move_expired',
  'bundle_unreadable',
  'bundle_mismatch',
  // MoMo's service ports (host/src/momoSeams.mjs): raised to a service in the Host, never by a chat write the ledger keys; the service keeps its work owed and asks again once a brain or the chat can take it
  'momo_check_unavailable',
  'momo_check_timeout',
  'momo_check_budget',
  'momo_check_failed',
  'momo_chat_unavailable',
  // MoMo's Google source: a wire method (`host.momoGoogle`), not a chat write, so the ledger never holds its answer
  'google_api',
  'google_unavailable',
]);
/** Every context a code is worded in, so a cause that allows Retry is seen. */
const CONTEXTS: object[] = [
  {},
  { agentState: 'ready', agentWas: 'missing' },
  { agentState: 'missing', installable: true },
  { details: { cause: 'org' } },
  { details: { cause: 'key' } },
  { details: { cause: 'lease_in_use' } },
];

test('a code the table lets the person Retry is one the Host answers again for the same key (or one the Host never sees)', () => {
  const retried = new Set<string>();
  for (const code of REFUSAL_CODES as string[])
    for (const ctx of CONTEXTS) if (refusalWords(code, { machine: 'm', agent: 'codex', message: 'x', ...ctx })!.retry) retried.add(code);
  assert.ok(retried.size > 10, 'the table offers Retry for some causes');
  const stuck = [...retried].filter((c) => !NOT_DONE.has(c) && !NOT_LEDGERED.has(c));
  assert.deepEqual(
    stuck,
    [],
    'Retry would be refused again with the same key: add the code to NOT_DONE (if the Host refused before doing anything) or make `retry` false',
  );
  // and an exemption is still a code the table words with Retry
  for (const c of NOT_LEDGERED) assert.ok(retried.has(c), `${c} is exempt but the table no longer offers Retry for it`);
});

test('the ledger runs a request again for each refusal on NOT_DONE and replays any other failure for the same key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-refusal-'));
  try {
    const ledger = createLedger(dir, { report: () => undefined });
    const run = async (code: string) => {
      let calls = 0;
      const once = () =>
        ledger.once({ chatId: 'c', key: `k-${code}`, method: 'chat.send' }, () => {
          calls++;
          if (calls === 1) throw Object.assign(new Error('refused'), { code });
          return 'taken';
        });
      await assert.rejects(once(), (e: any) => e.code === code);
      return {
        second: await once().then(
          (r: any) => r.result,
          (e: any) => e.code,
        ),
        calls,
      };
    };
    for (const code of NOT_DONE as Set<string>) assert.deepEqual(await run(code), { second: 'taken', calls: 2 }, code);
    // a failure of another kind is the key's answer, never run twice
    assert.deepEqual(await run('chat_unknown'), { second: 'chat_unknown', calls: 1 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
