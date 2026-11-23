// Builds the renderer into dist/ when it is missing or older than its sources, sage-mcp (the stdio MCP server harnesses
// launch to reach the app's tools) when it is missing or stale, and the Rust core's addon when it is missing or not from
// these sources, without which the app does not start (scripts/build-core.mjs ensureCore). Here and not a
// workflow step: every workflow gets it, including Electron's Linux PTY even after a dependency-cache restore.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const PTY_MODULE = 'scripts/linux-pty.mjs';
const VITE = 'node_modules/vite/bin/vite.js';

function newest(p: string): number {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  return Math.max(st.mtimeMs, ...fs.readdirSync(p).map((f) => newest(path.join(p, f))));
}

export default async function globalSetup() {
  // Linux node-pty has no prebuild. Keep its sources for later runs; package-only pruning would break a warm checkout.
  // Native dynamic import bypasses Playwright without passing an input-type flag to node-gyp's forked worker.
  if (process.platform === 'linux')
    execFileSync(
      process.execPath,
      [
        '--eval',
        'import(process.argv[1]).then(({ rebuildLinuxPty }) => rebuildLinuxPty({ buildPath: process.cwd(), arch: process.arch, prune: false })).catch(error => { console.error(error); process.exitCode = 1; });',
        './' + PTY_MODULE,
      ],
      { cwd: ROOT, stdio: 'inherit' },
    );
  // missing or older than its sources; waits for a concurrent build (unit tests, another run) instead of racing it
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-sage-mcp.mjs'), '--ensure'], { cwd: ROOT, stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-core.mjs'), '--ensure'], { cwd: ROOT, stdio: 'inherit' });
  const out = path.join(ROOT, 'dist', 'index.html');
  const sources = ['src', 'shared', 'index.html', 'vite.config.mts', 'package-lock.json']
    .map((f) => path.join(ROOT, f))
    .filter((f) => fs.existsSync(f));
  const built = fs.existsSync(out) ? fs.statSync(out).mtimeMs : 0;
  if (built && Math.max(...sources.map(newest)) <= built) return;
  // vite's own script under this Node: Windows has no `npx` executable to start (npx.cmd needs a shell)
  execFileSync(process.execPath, [path.join(ROOT, VITE), 'build', '--logLevel', 'warn'], { cwd: ROOT, stdio: 'inherit' });
}
