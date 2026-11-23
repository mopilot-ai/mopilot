// Shared by the Codex-on-a-Host tests: a stand-in `codex` CLI on a PATH of its own, and a Host over a data dir with its protocol and one client connection.
import { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { readJsonLineLog } from '../../scripts/fixture-json-log.mjs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createAcpRuntime } from '../../host/src/acp.mjs';
import { createCodexFamily } from '../../host/src/codexFamily.mjs';
import { createEpochStore } from '../../host/src/epochs.mjs';
import { createGuard } from '../../host/src/guard.mjs';
import { createLedger } from '../../host/src/ledger.mjs';
import { createPaths } from '../../host/src/paths.mjs';
import { createProtocol } from '../../host/src/protocol.mjs';
import { createHostSessions } from '../../host/src/sessions.mjs';
import { helloParams } from '../../shared/host/schema.mjs';

const ROOT = path.join(import.meta.dirname, '../..');
const FAKE = path.join(ROOT, 'tests/fixtures/fake-codex-app-server.mjs');
export const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-codex-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
export const until = async (fn: () => any, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** Put the stand-in `codex` on a PATH of its own; `login` is what `codex login status` answers. */
export function installCodex(dir: string, login: 'in' | 'out' = 'in') {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const file = path.join(bin, 'codex');
  fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  return { bin, env: { PATH: bin, FAKE_CODEX_LOGIN: login, FAKE_CODEX_LOG: path.join(dir, 'codex.jsonl') } };
}

/** A Host over `dir` (the data dir stays across `open` calls, as a restarted Host's does), its protocol and one client connection. */
export async function open(
  dir: string,
  env: Record<string, string> = installCodex(dir).env,
  hello: () => object = helloParams,
  codexOptions: object = {},
  protocolOptions: object = {},
) {
  const paths = createPaths({ dataDir: dir, env: {} });
  const runtime = createAcpRuntime({ paths, env: {} });
  let family: any;
  const factory = createCodexFamily({ env, ...codexOptions });
  const logs: string[] = [];
  const sessions = createHostSessions({
    paths,
    env,
    runtime,
    families: { codex: (context: any) => (family = factory(context)) },
    log: (line: string) => logs.push(line),
  });
  const quiet = { report: () => undefined };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const protocol = createProtocol({ runtime: sessions.chatRuntime, epochs, guard, status: () => ({ running: true }), ...protocolOptions });
  const frames: any[] = [];
  const conn = protocol.connection((m: any) => frames.push(m));
  await conn.call('host.hello', hello());
  let n = 0;
  const seed = crypto.randomUUID().slice(0, 8);
  const key = () => `key-${seed}-${++n}`;
  const call = (method: string, chatId: string, p: any = {}) => conn.call(method, { chatId, epoch: 1, key: key(), ...p });
  const requests = () => readJsonLineLog(env.FAKE_CODEX_LOG);
  const events = (chatId: string) =>
    frames.filter((m) => m.frame?.item?.t === 'event' && m.chatId === chatId).map((m) => m.frame.item.event);
  const replies = (chatId: string) =>
    frames.filter((m) => m.chatId === chatId && m.frame?.item?.t === 'assistant').map((m) => m.frame.item);
  const close = () => (sessions.close(), runtime.close());
  return { dir, env, paths, runtime, sessions, protocol, conn, frames, call, key, requests, replies, events, close, family, logs };
}

/** The error a call fails with. */
export const refusal = (call: Promise<unknown>): Promise<any> =>
  call.then(
    () => assert.fail('the call was meant to be refused'),
    (e) => e,
  );
