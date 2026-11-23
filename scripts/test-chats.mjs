// A test run's chats on the user's real logins (#1724; agents run app checks only in the VM or on CI runners, AGENTS.md): the scratch project folder its chats start in, and its cleanup over the dev instance's debugging port (archive the run's chats by that folder, then remove the folder).
//
//   node scripts/test-chats.mjs folder --run <tag>
//     makes <test root>/<tag>/project (/private/tmp/mopilot-test on macOS) and prints it: start every test chat there
//     (startNewChat's cwd), never projectless. Launch the instance with MOPILOT_TEST_RUN=<tag> too, so a chat started
//     projectless anyway lands under <test root>/<tag>/ (electron/platform/testChats.cjs).
//   node scripts/test-chats.mjs cleanup --port <debugging port> --run <tag> [--dry-run]
//     archives, in that dev instance, every chat whose folder is under <test root>/<tag> (only those: the folder is the
//     run's own), then removes the folder. Archiving a Codex chat archives its thread in ~/.codex too; a Claude Code
//     session has no archive of its own, so the user's own MoPilot still lists it (under the removed folder).
//
// Only a dev instance (npm run dev) serves the store modules the cleanup imports; a packaged build has none.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const { TEST_CHATS_ROOT, RUN_TAG } = createRequire(import.meta.url)('../electron/platform/testChats.cjs');

/** The run's folder (every chat of the run is under it); a tag that is not one folder name is refused. */
export function runFolder(tag, root = TEST_CHATS_ROOT) {
  if (!RUN_TAG.test(String(tag ?? ''))) throw new Error(`"${tag}" is not a run tag: letters, digits, . _ - (at most 64)`);
  return path.join(root, String(tag));
}

/** The command and its `--name value` / `--flag` options. */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  /** @type {Record<string, string | true>} */
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const m = /^--([\w-]+)$/.exec(rest[i]);
    if (!m) throw new Error(`Unexpected argument: ${rest[i]}`);
    opts[m[1]] = rest[i + 1] !== undefined && !rest[i + 1].startsWith('--') ? rest[++i] : true;
  }
  return { command, opts };
}

/** In the app's page: archive the chats whose folder is under `prefix`, through the store's own archive (the sidebar's). */
export const ARCHIVE_JS = `async (prefix, dry) => {
  const { get: getState } = await import('/src/store/core.ts');
  const { archiveThread } = await import('/src/store/actions.ts');
  // macOS spells /tmp as /private/tmp too: a chat started under either spelling is the run's
  const roots = [prefix, prefix.startsWith('/private/') ? prefix.slice('/private'.length) : prefix];
  const ids = Object.values(getState().threads)
    .filter((t) => typeof t?.cwd === 'string' && roots.some((r) => t.cwd === r || t.cwd.startsWith(r + '/')))
    .map((t) => t.id);
  const archived = [];
  const failed = [];
  for (const id of dry ? [] : ids) {
    try {
      await archiveThread(id);
      archived.push(id);
    } catch (e) {
      failed.push({ id, error: String((e && e.message) || e) });
    }
  }
  return { found: ids, archived, failed };
}`;

/** The app's own window among a debugging port's targets: the dev renderer's page, not a browser-pane guest or the mini window. */
export function appTarget(targets) {
  return (
    targets.find(
      (t) => t.type === 'page' && /^https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/(?:[?#](?!mini)|$)/.test(t.url) && t.webSocketDebuggerUrl,
    ) ?? null
  );
}

/** Evaluates `fn(...args)` in the page over raw CDP; resolves to its value, or rejects after `ms` without an answer. */
export function evaluate(wsUrl, fn, args, WS = WebSocket, ms = 60_000) {
  return new Promise((resolve, reject) => {
    const ws = new WS(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`No answer from ${wsUrl} in ${ms / 1000} s`));
    }, ms);
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`Couldn't reach ${wsUrl}`));
    };
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression: `(${fn})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true },
        }),
      );
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      const ex = msg.result?.exceptionDetails;
      if (msg.error || ex) reject(new Error(msg.error?.message ?? ex.exception?.description ?? ex.text));
      else resolve(msg.result.result.value);
    };
  });
}

const removeFolder = (/** @type {string} */ folder) => fs.rmSync(folder, { recursive: true, force: true });

/**
 * Archives the run's chats in the instance on `port`, then removes the run's folder (kept after a failed archive or a
 * dry run, so a second cleanup can finish it).
 * @param {{ port: number, run: string, dry?: boolean, root?: string, fetch?: typeof fetch, WS?: typeof WebSocket, rm?: (p: string) => void }} o
 */
export async function cleanup({ port, run, dry = false, root = TEST_CHATS_ROOT, fetch: get = fetch, WS = WebSocket, rm = removeFolder }) {
  const folder = runFolder(run, root);
  if (!Number.isInteger(port) || port <= 0) throw new Error('--port must be the dev instance’s debugging port');
  const targets = await (await get(`http://127.0.0.1:${port}/json/list`)).json();
  const page = appTarget(targets);
  if (!page) throw new Error(`No MoPilot dev window on port ${port}`);
  const r = await evaluate(page.webSocketDebuggerUrl, ARCHIVE_JS, [folder, dry], WS);
  const removed = !dry && !r.failed.length;
  if (removed) rm(folder);
  return { folder, ...r, removed };
}

/** Runs one command line; resolves to what it prints, rejects with what went wrong. */
export async function main(argv, deps = {}) {
  const { command, opts } = parseArgs(argv);
  if (command === 'folder') {
    const dir = path.join(runFolder(opts.run, deps.root), 'project');
    (deps.mkdir ?? ((/** @type {string} */ d) => fs.mkdirSync(d, { recursive: true })))(dir);
    return dir;
  }
  if (command === 'cleanup') {
    const dry = opts['dry-run'] === true;
    const r = await cleanup({ ...deps, port: Number(opts.port), run: String(opts.run), dry });
    const lines = [
      `${r.found.length} chat(s) under ${r.folder}${dry ? ' (dry run)' : ''}`,
      ...r.archived.map((id) => `archived ${id}`),
      ...r.failed.map((f) => `FAILED ${f.id}: ${f.error}`),
      `${r.removed ? 'removed' : 'kept'} ${r.folder}`,
    ];
    if (r.failed.length) throw new Error(lines.join('\n'));
    return lines.join('\n');
  }
  throw new Error('Usage: node scripts/test-chats.mjs folder --run <tag> | cleanup --port <port> --run <tag> [--dry-run]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (out) => console.log(out),
    (e) => {
      console.error(e.message);
      process.exitCode = 1;
    },
  );
}
