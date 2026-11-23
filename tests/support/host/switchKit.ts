// A Host that runs all three families for the switch tests (hostChatSwitchSettle.test.ts): Claude Code over a fake Agent SDK, Codex over a stand-in app-server on the PATH and a fake ACP agent, with the Host's protocol and one client connection.
import { after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonLineLog } from '../../../scripts/fixture-json-log.mjs';
// @ts-ignore: plain ESM without declarations
import { createAcpRuntime } from '../../../host/src/acp.mjs';
import { createClaudeFamily } from '../../../host/src/claudeFamily.mjs';
import { createCodexFamily } from '../../../host/src/codexFamily.mjs';
import { installElectronPorts } from '../../../host/src/electronPorts.mjs';
import { createEpochStore } from '../../../host/src/epochs.mjs';
import { createGuard } from '../../../host/src/guard.mjs';
import { createLedger } from '../../../host/src/ledger.mjs';
import { createContinueWiring } from '../../../host/src/continueWiring.mjs';
import { createHostFs } from '../../../host/src/hostFs.mjs';
import { createPaths } from '../../../host/src/paths.mjs';
import { createCredentialLeases } from '../../../host/src/credentialLease.mjs';
import { createOwnCredentials } from '../../../host/src/ownCredentials.mjs';
import { createProtocol } from '../../../host/src/protocol.mjs';
import { createHostSessions } from '../../../host/src/sessions.mjs';
import { helloParams } from '../../../shared/host/schema.mjs';
import { installCodex } from '../hostCodexKit.ts';
// @ts-ignore: plain ESM without declarations
import { createFakeClaudeSdk } from '../fakeClaudeSdk.mjs';

const ROOT = path.join(import.meta.dirname, '../../..');
const AGENT = path.join(ROOT, 'tests/fixtures/fake-acp-agent.mjs');
export const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-switch-')));
export const configDir = path.join(base, 'claude-config');
// the transcripts the Claude harness looks for are the Host user's own, here a folder of this run
process.env.CLAUDE_CONFIG_DIR = configDir;
after(() => fs.rmSync(base, { recursive: true, force: true }));
export const until = async (fn: () => any, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** Which families a Host runs: the others are left out, as on a machine without that agent. */
export type Families = { claude?: boolean; codex?: boolean };
/** The chat id each agent names its chats by, and the harness a start asks for. */
export const AGENTS = {
  claude: { harness: 'claude', id: () => `claude:${crypto.randomUUID()}` },
  codex: { harness: 'codex', id: () => `chat-${crypto.randomUUID().slice(0, 8)}` },
  acp: { harness: 'acp:fake', id: () => `acp:fake:${crypto.randomUUID().slice(0, 8)}` },
} as const;
export type Agent = keyof typeof AGENTS;

/** A Host over `dir` (kept across `openAll` calls, as a restarted Host's is), its protocol and one client connection. */
export async function openAll(
  dir: string,
  families: Families = { claude: true, codex: true },
  options: { credentials?: boolean; history?: boolean; acpModels?: boolean; continues?: boolean; strictResume?: boolean } = {},
) {
  const codex = installCodex(dir);
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\n');
  const env = {
    ...codex.env,
    ...(options.history === false ? {} : { FAKE_CODEX_KEEP_INPUTS: '1' }),
    // a thread Codex has no rollout for is not resumable, as on a real machine
    ...(options.strictResume ? { FAKE_CODEX_STRICT_RESUME: path.join(dir, 'codex-rollouts.txt') } : {}),
    MOPILOT_CLAUDE_BIN: bin,
  };
  const acpLog = path.join(dir, 'agent.jsonl');
  fs.writeFileSync(
    path.join(dir, 'harnesses.json'),
    JSON.stringify({
      fake: {
        label: 'Fake',
        bin: process.execPath,
        args: [AGENT],
        env: {
          FAKE_ACP_STATE: path.join(dir, 's'),
          FAKE_ACP_LOG: acpLog,
          // the machine's ACP agent with a model to pick, as the e2e fixtures give it
          ...(options.acpModels
            ? {
                FAKE_ACP_PROFILE: JSON.stringify({
                  configOptions: [
                    {
                      id: 'model',
                      name: 'Model',
                      category: 'model',
                      type: 'select',
                      currentValue: 'fake-1',
                      options: [{ value: 'fake-1', name: 'Fake 1' }],
                    },
                  ],
                }),
              }
            : {}),
        },
      },
    }),
  );
  const paths = createPaths({ dataDir: dir, env: {} });
  const restore = installElectronPorts({
    paths: { dataDir: dir, configDir: path.join(dir, 'config') },
    openExternal: async () => undefined,
  });
  const runtime = createAcpRuntime({ paths, env: {}, hostOptions: { cancelRetryMs: 5, cancelForceMs: 30 } });
  const fake = createFakeClaudeSdk({ configDir, recordInputs: true, recordReplies: true });
  const made: any = {};
  /** What the Host's sessions reported (files it could not read or write). */
  const reported: string[] = [];
  const ownRuns = options.credentials ? createOwnCredentials({ leases: createCredentialLeases(), dataDir: dir }) : null;
  const sessions = createHostSessions({
    paths,
    env,
    runtime,
    families: {
      ...(families.claude
        ? { claude: (ctx: any) => (made.claude = createClaudeFamily({ sdk: fake.sdk, ...(ownRuns ? { ownRuns } : {}) })(ctx)) }
        : {}),
      ...(families.codex
        ? {
            codex: (ctx: any) =>
              (made.codex = createCodexFamily({ env, ...(ownRuns ? { credentials: ownRuns.chatCredentials } : {}) })(ctx)),
          }
        : {}),
    },
    ownRuns,
    report: (m: string) => void reported.push(m),
  });
  const quiet = { report: () => undefined };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const ledger = createLedger(path.join(dir, 'l'), quiet);
  const guard = createGuard({ epochs, ledger });
  const harnesses: {
    id: string;
    detected: boolean;
    signedIn: boolean;
    keyed?: boolean;
    signIn?: string[];
    sources?: { key?: boolean; org?: boolean };
  }[] = [
    { id: 'claude', detected: true, signedIn: true },
    { id: 'codex', detected: true, signedIn: true },
    { id: 'fake', detected: true, signedIn: true },
  ];
  // the continue pieces a Host process wires (host/src/continueWiring.mjs), over the same sessions and agents
  const wiring = options.continues
    ? createContinueWiring({
        dataDir: dir,
        runtime,
        families: { chats: sessions.chatRuntime, harnesses: async () => harnesses },
        hostFs: createHostFs({}),
        epochs,
        ledger,
        report: (m: string) => void reported.push(m),
      })
    : null;
  const protocol = createProtocol({
    runtime: sessions.chatRuntime,
    epochs,
    guard,
    dataDir: dir,
    ...(ownRuns ? { ownRuns } : {}),
    status: () => ({ running: true, harnesses }),
    ...(wiring ? { continueHost: wiring.continueHost, handoffs: wiring.target } : {}),
  });
  const frames: any[] = [];
  const conn = protocol.connection((m: any) => frames.push(m));
  const agreed = (await conn.call('host.hello', helloParams())).agreed;
  let n = 0;
  const seed = crypto.randomUUID().slice(0, 8);
  const call = (method: string, chatId: string, p: any = {}) => conn.call(method, { chatId, epoch: 1, key: `key-${seed}-${++n}`, ...p });
  /** A second client that subscribes now: the lane as a Hello hands it. */
  const hello = async (chatId: string) => {
    const seen: any[] = [];
    const other = protocol.connection((m: any) => seen.push(m));
    await other.call('host.hello', helloParams());
    await other.call('chat.subscribe', { chatId, epoch: 1 });
    return seen;
  };
  /** The lane patches the chat's clients were told, in order. */
  const lane = (chatId: string) => frames.filter((m) => m.chatId === chatId && m.frame?.t === 'state').map((m) => m.frame.patch);
  const turnEnds = (chatId: string) =>
    frames.filter((m) => m.chatId === chatId && m.frame?.item?.t === 'event' && m.frame.item.event?.kind === 'turnEnd').length;
  const idle = async (chatId: string, ended: number) => {
    await until(() => turnEnds(chatId) >= ended);
    await until(() => sessions.state.snapshot(chatId).turn === 'idle');
  };
  /** What each agent was sent, in order: Claude's messages, Codex's turn inputs, the ACP agent's prompts. */
  const prompts = {
    claude: () =>
      fake.queries.flatMap((q: any) =>
        q.messages.map((m: any) => (typeof m.content === 'string' ? m.content : m.content.map((b: any) => b.text ?? '').join(''))),
      ),
    codex: () =>
      readJsonLineLog(env.FAKE_CODEX_LOG)
        .filter((r: any) => r.method === 'turn/start')
        .map((r: any) => r.params.input.map((b: any) => b.text ?? '').join('')),
    acp: () =>
      fs.existsSync(acpLog)
        ? readJsonLineLog(acpLog)
            .filter((l: any) => l.msg?.method === 'session/prompt')
            .map((l: any) => l.msg.params.prompt.map((b: any) => b.text ?? '').join(''))
        : [],
  };
  const close = async () => {
    wiring?.close();
    sessions.close();
    runtime.close();
    await made.claude?.close?.();
    restore();
  };
  return {
    ownRuns,
    wiring,
    epochs,
    reported,
    agreed,
    made,
    dir,
    sessions,
    protocol,
    conn,
    frames,
    call,
    lane,
    idle,
    hello,
    prompts,
    harnesses,
    close,
    fake,
  };
}
export type SwitchHost = Awaited<ReturnType<typeof openAll>>;
