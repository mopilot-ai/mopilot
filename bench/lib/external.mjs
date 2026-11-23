// The third-party benchmarks the harness runs (never copied into this repository): pinned commits, where each checkout
// lives under bench/external, and the commands that fetch and build them.
import path from 'node:path';

/** Each benchmark's upstream repository and the commit the SMOKE baseline was measured on. */
export const PINS = {
  webgames: { repo: 'https://github.com/convergence-ai/webgames.git', commit: '309866f64642b864414ca2c7ff956e59e01d3317' },
  agisdk: { repo: 'https://github.com/agi-inc/agisdk.git', commit: '97a245dcbccd3e1cf4d5ee00d5b1707942258518' },
  MacArena: { repo: 'https://github.com/MacPaw/MacArena.git', commit: 'dcdc7d366da12641578ab90f085d69db91651c58' },
};

/** Paths inside the external checkouts that the runner reads. @param {string} external */
export function externalPaths(external) {
  const real = path.join(external, 'agisdk/src/agisdk/REAL/browsergym/webclones/v2');
  return {
    webgamesCatalog: path.join(external, 'webgames/analysis/webgames_tasks.jsonl'),
    webgamesApp: path.join(external, 'webgames/webgames'),
    webgamesDist: path.join(external, 'webgames/webgames/dist'),
    realTasks: path.join(real, 'tasks'),
    realGraders: path.join(real, 'eval_scripts'),
    macarena: path.join(external, 'MacArena'),
    macarenaTasks: path.join(external, 'MacArena/evaluation_examples/macarena'),
  };
}

/**
 * The commands that bring bench/external to the pinned commits and build WebGames: [command, args, cwd] each.
 * A checkout that exists is fetched and checked out again rather than cloned.
 * @param {string} external
 * @param {(p: string) => boolean} exists
 */
export function setupCommands(external, exists) {
  /** @type {[string, string[], string][]} */
  const out = [];
  for (const [name, { repo, commit }] of Object.entries(PINS)) {
    const dir = path.join(external, name);
    if (!exists(dir)) out.push(['git', ['clone', '--filter=blob:none', repo, dir], external]);
    else out.push(['git', ['fetch', 'origin'], dir]);
    out.push(['git', ['checkout', '--detach', commit], dir]);
  }
  const app = externalPaths(external).webgamesApp;
  out.push(['npx', ['--yes', 'pnpm@9', 'install', '--frozen-lockfile'], app]);
  out.push(['npx', ['--yes', 'pnpm@9', 'run', 'build'], app]);
  return out;
}
