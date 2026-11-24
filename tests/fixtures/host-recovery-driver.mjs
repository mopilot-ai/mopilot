// A Host's wiring for the recovery test (the same pieces `serve` puts together: recovery, sessions with a Codex family and an ACP harness, the protocol), driven by a script instead of a socket. `start <data dir>` begins a slow Codex turn and a slow ACP turn and waits to be killed; `restart <data dir>` recovers from the run before, prints what it ended and what a client subscribing to the chats is given, and exits.
import fs from 'node:fs';
import path from 'node:path';
import { createAcpRuntime } from '../../host/src/acp.mjs';
import { createClaudeFamily } from '../../host/src/claudeFamily.mjs';
import { createCodexFamily } from '../../host/src/codexFamily.mjs';
import { installElectronPorts } from '../../host/src/electronPorts.mjs';
import { createEpochStore } from '../../host/src/epochs.mjs';
import { createGuard } from '../../host/src/guard.mjs';
import { createLedger } from '../../host/src/ledger.mjs';
import { createPaths } from '../../host/src/paths.mjs';
import { createProtocol } from '../../host/src/protocol.mjs';
import { createRecovery } from '../../host/src/recovery.mjs';
import { createHostSessions } from '../../host/src/sessions.mjs';
import { helloParams } from '../../shared/host/schema.mjs';
import { createFakeClaudeSdk } from '../support/fakeClaudeSdk.mjs';

const [mode, dataDir] = process.argv.slice(2);
const CODEX_CHAT = 'cx-recover';
const ACP_CHAT = 'acp:fake:recover';
const CLAUDE_CHAT = 'claude:6f1d1b0e-2c1a-4f6e-9a55-0d3f6a1b7c42';
const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const env = process.env;

const paths = createPaths({ dataDir, env: {} });
const quiet = { report: () => undefined };
const recovery = createRecovery({ dataDir });
recovery.install();
// the Claude harness reads its folders through the ports `serve` installs; its transcripts are this run's own
process.env.CLAUDE_CONFIG_DIR = path.join(dataDir, 'claude-config');
installElectronPorts({ paths: { dataDir, configDir: path.join(dataDir, 'config') }, openExternal: async () => undefined });
const fake = createFakeClaudeSdk({
  configDir: process.env.CLAUDE_CONFIG_DIR,
  cli: new URL('./fake-claude-cli.mjs', import.meta.url).pathname,
});
const runtime = createAcpRuntime({ paths, env });
const sessions = createHostSessions({
  paths,
  env,
  runtime,
  families: {
    codex: createCodexFamily({ env }),
    claude: createClaudeFamily({ sdk: fake.sdk }),
  },
});
const epochs = createEpochStore(path.join(dataDir, 'e.json'), quiet);
const guard = createGuard({ epochs, ledger: createLedger(path.join(dataDir, 'l'), quiet) });
const protocol = createProtocol({
  runtime: sessions.chatRuntime,
  epochs,
  guard,
  status: () => ({ running: true }),
  journal: recovery.journal,
});

// the lock is the test's business here: this is the point `serve` reaches once it holds it
const recovered = await recovery.run(protocol);
const frames = [];
const conn = protocol.connection((m) => frames.push(m));
await conn.call('host.hello', helloParams());
let n = 0;
const call = (method, chatId, p = {}) => conn.call(method, { chatId, epoch: 1, key: `key-rec-${process.pid}-${++n}`, ...p });

if (mode === 'start') {
  await call('chat.subscribe', CODEX_CHAT);
  await call('chat.subscribe', ACP_CHAT);
  await call('chat.subscribe', CLAUDE_CHAT);
  await call('chat.start', CODEX_CHAT, { harness: 'codex', text: 'slow work', cwd: path.dirname(dataDir) });
  await call('chat.start', ACP_CHAT, { harness: 'acp:fake', text: 'SLOW work', cwd: path.dirname(dataDir) });
  await call('chat.start', CLAUDE_CHAT, { harness: 'claude', text: 'SLOW work', cwd: path.dirname(dataDir) });
  const busy = () =>
    ['running', 'awaitingUser'].includes(sessions.state.snapshot(CODEX_CHAT).turn) &&
    ['running', 'awaitingUser'].includes(sessions.state.snapshot(ACP_CHAT).turn) &&
    ['running', 'awaitingUser'].includes(sessions.state.snapshot(CLAUDE_CHAT).turn);
  while (!busy()) await new Promise((r) => setTimeout(r, 20));
  // the ACP agent's first chunk shows its turn is really under way
  while (!frames.some((m) => m.chatId === ACP_CHAT && m.frame?.t === 'delta')) await new Promise((r) => setTimeout(r, 20));
  say({ ready: true, children: JSON.parse(fs.readFileSync(path.join(dataDir, 'children.json'), 'utf8')).children, pid: process.pid });
  setInterval(() => undefined, 1000);
} else {
  const snapshots = {};
  for (const chatId of [CODEX_CHAT, ACP_CHAT, CLAUDE_CHAT]) {
    const out = [];
    const c = protocol.connection((m) => out.push(m));
    await c.call('host.hello', helloParams());
    await c.call('chat.subscribe', { chatId, epoch: 1 });
    snapshots[chatId] = out.find((m) => m.frame?.t === 'hello')?.frame.snapshot;
  }
  say({ recovered, snapshots, idle: sessions.idle() });
  sessions.close();
  runtime.close();
  process.exit(0);
}
