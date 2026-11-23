// Fetches the third-party benchmarks into bench/external at their pinned commits and builds WebGames, inside the
// benchmark VM only: the build runs the benchmark's own install scripts. Usage: node bench/setup-external.mjs [dir]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { BENCH_DIR } from './lib/config.mjs';
import { setupCommands } from './lib/external.mjs';
import { requireVm } from './lib/guard.mjs';

requireVm('bench/setup-external.mjs');
const external = process.argv[2] ?? `${BENCH_DIR}external`;
mkdirSync(external, { recursive: true });
for (const [cmd, args, cwd] of setupCommands(external, existsSync)) {
  console.log(`$ (${cwd}) ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}
