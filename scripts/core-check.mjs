// The Rust core's static checks (docs/architecture/rust-core.md §9): rustfmt and clippy, run inside core/ so rustup
// takes the toolchain core/rust-toolchain.toml pins. The pre-commit hook runs it when Rust or Cargo files are staged.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const CORE = path.join(root, 'core');

/** The checks, in order, each with what to do when it fails. @type {[string[], string][]} */
export const CHECKS = [
  [['fmt', '--check'], 'Format the core with `cargo fmt` in core/.'],
  [['clippy', '--all-targets', '--', '-D', 'warnings'], 'Fix the clippy warnings above.'],
];

/**
 * Run each check in `cwd`; stop at the first that fails. Returns the exit code.
 * @param {{ run?: (cmd: string, args: string[], cwd: string) => { status: number | null, error?: Error }, log?: (m: string) => void, cwd?: string }} [deps]
 */
export function coreCheck({
  run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, stdio: 'inherit' }),
  log = console.error,
  cwd = CORE,
} = {}) {
  for (const [args, fix] of CHECKS) {
    const result = run('cargo', args, cwd);
    if (result.error) {
      log(`core-check: cargo did not start (${result.error.message}). Install the Rust toolchain with rustup (https://rustup.rs).`);
      return 1;
    }
    if (result.status !== 0) {
      log(`core-check: \`cargo ${args.join(' ')}\` failed. ${fix}`);
      return 1;
    }
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = coreCheck();
