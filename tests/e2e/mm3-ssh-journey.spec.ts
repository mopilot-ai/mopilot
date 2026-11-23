// e2e-runner: bench
// MM3, the journey of the Remote Run acceptance matrix for the Mac app against a real Host over real ssh: a second real Host process on this runner (its own data dir, the repo's fake ACP agent as its only agent), reached through the runner's sshd and the app's ssh tunnel, and the same journey and timings as mm3-journey.spec.ts (start and stream, a tool, an approval, Stop, quit and reopen, a second chat and switching).
// It turns on sshd and writes the user's ssh config, so it runs only on a CI runner. Named on the command line only: `node scripts/ci-cuj.mjs --spec tests/e2e/mm3-ssh-journey.spec.ts`.
import fs from 'node:fs';
import os from 'node:os';
import { test } from './fixtures/app';
import { runJourney } from './fixtures/mm3Journey';
import { REMOTE_FOLDER, type RemoteHost, connectRemote, sshToSelf, startRemoteChat, startRemoteHost } from './fixtures/remoteHost';

test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');
test.skip(!process.env.GITHUB_ACTIONS, 'a runner only: it turns on sshd and writes the ssh config');

const HOME = os.homedir();
let remote: RemoteHost;

test.beforeAll(async () => {
  fs.mkdirSync(REMOTE_FOLDER, { recursive: true });
  sshToSelf();
  remote = await startRemoteHost({ agents: 'acp' });
});
test.afterAll(() => {
  remote?.stop();
  fs.rmSync(REMOTE_FOLDER, { recursive: true, force: true });
});

test.setTimeout(10 * 60_000);
test.use({
  harnesses: 'codex',
  acp: { kimi: {} },
  env: { MOPILOT_HOST_DEV: '1', HOME },
  seed: {
    userData: {
      'host-registry.json': {
        version: 1,
        hosts: [
          {
            id: 'ssh:runner@localhost',
            name: 'localhost',
            address: 'runner@localhost',
            // where startRemoteHost puts the Host's socket (fixtures/remoteHost.ts REMOTE_SOCKET)
            socketPath: '/tmp/mm-remote-host/data/host.sock',
            capabilities: { shell: true },
            harnesses: [],
            // read when the seed is written, not when the worker loads this file (hostFixtureHeartbeat.invariant.test.ts)
            get lastHeartbeat() {
              return Date.now();
            },
            setup: '',
          },
        ],
      },
    },
  },
});

test('A real Host over real ssh: start, stream, a tool, an approval, Stop, quit and reopen, a second chat', ({ harness }) =>
  runJourney(harness, {
    name: 'A real Host over real ssh',
    setup: (h) => connectRemote(h.page, remote, 'fake'),
    start: (h, message, another) => startRemoteChat(h.page, 'Kimi Code', message, another),
  }));
