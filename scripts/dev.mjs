// Starts the Vite dev server and launches Electron pointed at it.
// SAGE_DEV_PORT / SAGE_DEBUG_PORT / SAGE_USER_DATA let a second checkout run alongside.
// A test instance (SAGE_E2E_BACKGROUND=1 or MOPILOT_TEST_RUN) starts only where a release-only suite may: AGENTS.md
// keeps app checks off the user's Mac, in the virtual machine (scripts/vm-exec.sh) or on CI runners.
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { ensureSageMcp } from './build-sage-mcp.mjs';
import { ensureCore } from './build-core.mjs';

const { requireRelease } = createRequire(import.meta.url)('./release-suites.cjs');

/** Builds sage-mcp if needed (macOS), starts the server, then Electron; when Electron exits, closes the server and calls `exit(0)`. Returns the child. A test instance outside a release, a VM or CI throws first. */
export async function startDev({
  env = process.env,
  create = createServer,
  run = spawn,
  electronPath = /** @type {string} */ (/** @type {unknown} */ (electron)),
  exit = process.exit,
  ensure = ensureSageMcp,
  buildCore = ensureCore,
  platform = process.platform,
  log = console.log,
  gate = requireRelease,
} = {}) {
  if (env.SAGE_E2E_BACKGROUND === '1' || env.MOPILOT_TEST_RUN)
    gate('A test instance of MoPilot', 'opens MoPilot windows on this computer and its chats use the logins here', env);
  // the tool bridge, built when missing or stale: without it every chat runs without MoPilot's tools, silently (#1362).
  // A build that fails still starts the app, saying so, as one without swift does
  if (platform === 'darwin') {
    let built = /** @type {string | null} */ (null);
    try {
      built = ensure({ log });
    } catch (error) {
      log(`sage-mcp could not be built: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!built) log('sage-mcp is not built: chats in this run get no MoPilot tools.');
  }
  // the app does not start without the Rust core, and says so
  buildCore({ log });
  const port = Number(env.SAGE_DEV_PORT) || undefined;
  const server = await create({ configFile: 'vite.config.mts', ...(port ? { server: { port, strictPort: true } } : {}) });
  await server.listen();
  // listen() resolved, so the server has its URLs
  const url = /** @type {NonNullable<typeof server.resolvedUrls>} */ (server.resolvedUrls).local[0];
  const debugPort = env.SAGE_DEBUG_PORT || '9339';
  const child = run(electronPath, ['.', `--remote-debugging-port=${debugPort}`], {
    stdio: 'inherit',
    env: { ...env, VITE_DEV_SERVER_URL: url },
  });
  child.on('exit', () => {
    server.close();
    exit(0);
  });
  return child;
}

/** The command line: --help prints the usage, anything else starts the dev setup. */
export async function cli(argv, { start = startDev, log = console.log } = {}) {
  if (argv.includes('--help'))
    log('usage: npm run dev (SAGE_DEV_PORT, SAGE_DEBUG_PORT and SAGE_USER_DATA run a second checkout alongside)');
  else await start();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await cli(process.argv.slice(2));
