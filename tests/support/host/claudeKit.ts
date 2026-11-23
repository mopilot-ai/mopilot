// A Host's sessions with the Claude family over a fake Agent SDK, shared by the Claude Code Host tests (hostClaude.test.ts, hostClaudeStop.test.ts).
import { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createAcpRuntime } from '../../../host/src/acp.mjs';
import { createClaudeFamily } from '../../../host/src/claudeFamily.mjs';
import { installElectronPorts } from '../../../host/src/electronPorts.mjs';
import { createPaths } from '../../../host/src/paths.mjs';
import { createHostSessions } from '../../../host/src/sessions.mjs';
// @ts-ignore: plain ESM without declarations
import { createFakeClaudeSdk } from '../fakeClaudeSdk.mjs';

export const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-claude-')));
export const configDir = path.join(base, 'claude-config');
// the transcripts the harness looks for are the Host user's own, here a folder of this run
process.env.CLAUDE_CONFIG_DIR = configDir;
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
export const uuid = () => crypto.randomUUID();
export const keyOf = () => `claude:${uuid()}`;

/** A Host's sessions with the Claude family over a fake SDK. */
export function setup(
  dir = fs.mkdtempSync(path.join(base, 'd-')),
  fake = createFakeClaudeSdk({ configDir }),
  /** the owner's permission ceiling, read each time a turn takes its settings */
  ceiling?: () => string | undefined,
) {
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\n');
  const paths = createPaths({ dataDir: dir, env: {} });
  const restore = installElectronPorts({
    paths: { dataDir: dir, configDir: path.join(dir, 'config') },
    openExternal: async () => undefined,
  });
  const runtime = createAcpRuntime({ paths, env: {}, hostOptions: { cancelRetryMs: 5, cancelForceMs: 30 } });
  let family: any;
  const make = createClaudeFamily({ sdk: fake.sdk });
  const sessions = createHostSessions({
    paths,
    env: { MOPILOT_CLAUDE_BIN: bin },
    runtime,
    families: { claude: (ctx: any) => (family = make(ctx)) },
    ...(ceiling ? { ceiling } : {}),
  });
  const events: any[] = [];
  sessions.chatRuntime.host.on('event', (e: any) => events.push(e));
  const of = (kind: string, key?: string) => events.filter((e) => e.kind === kind && (!key || e.key === key));
  const text = (key: string) =>
    events
      .filter((e) => e.key === key && e.update?.sessionUpdate === 'agent_message_chunk')
      .map((e) => e.update.content.text)
      .join('');
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    sessions.close();
    runtime.close();
    await family.close();
    restore();
  };
  return { dir, fake, sessions, runtime, make, family, events, of, text, close, state: (key: string) => sessions.state.snapshot(key) };
}
export type Host = ReturnType<typeof setup>;
export const idle = (h: Host, key: string) => until(() => h.state(key).turn === 'idle' && h.of('turnEnd', key).length > 0);
