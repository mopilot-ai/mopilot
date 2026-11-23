// Writes a fake command (gh, git, ssh, an ACP harness, the Claude CLI) that runs a Node script with this Node: a `#!/bin/sh` script on macOS and Linux, a launcher .exe on Windows (node-launcher.rs); and a PATH that puts folders first.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LAUNCHER_SOURCE = path.join(__dirname, 'node-launcher.rs');

/**
 * The launcher, built once per version of its source into the temp folder with rustc (a Windows checkout has it for the
 * Rust core). Spec files call this while Playwright lists them, so it is synchronous; a second process that builds it
 * at the same time keeps its own copy.
 */
function launcher(): string {
  const source = fs.readFileSync(LAUNCHER_SOURCE);
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 12);
  const exe = path.join(os.tmpdir(), `mopilot-e2e-launcher-${hash}.exe`);
  if (fs.existsSync(exe)) return exe;
  // rustc writes a .pdb beside its output: build in a folder of its own and keep only the program
  const build = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-e2e-launcher-build-'));
  try {
    const built = path.join(build, 'launcher.exe');
    execFileSync('rustc', ['--edition', '2021', '-O', '-o', built, LAUNCHER_SOURCE], { stdio: 'inherit' });
    try {
      fs.renameSync(built, exe);
    } catch (error) {
      // another process put its copy there first (and may be running it, which Windows will not let a rename replace)
      if (!fs.existsSync(exe)) throw error;
    }
  } finally {
    fs.rmSync(build, { recursive: true, force: true });
  }
  return exe;
}

/**
 * Puts the command `name` in `dir`: it runs `script` with this Node, with `env` added to its environment, and passes its
 * arguments, standard streams and exit code through. The command's path is returned: `dir/name` on macOS and Linux,
 * `dir/name.exe` on Windows, where execFile finds only a program (.exe), not a script, on PATH.
 */
export function nodeCommand(dir: string, name: string, script: string, env: Record<string, string> = {}): string {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform !== 'win32') {
    const exports = Object.entries(env)
      .map(([k, v]) => `export ${k}='${v.replace(/'/g, `'\\''`)}'\n`)
      .join('');
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${exports}exec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
    return file;
  }
  const vars = Object.entries(env).map(([k, v]) => {
    if (/[\r\n]/.test(v)) throw new Error(`${name}: ${k} holds a line break, which the launcher's plan cannot carry`);
    return `${k}=${v}`;
  });
  const file = path.join(dir, `${name}.exe`);
  fs.copyFileSync(launcher(), file);
  fs.writeFileSync(path.join(dir, `${name}.launch`), `${[process.execPath, script, ...vars].join('\n')}\n`);
  return file;
}

/** `dirs`, then `rest` (this process's PATH), as one PATH: `:` between them on macOS and Linux, `;` on Windows. */
export function withPath(dirs: string[], rest = process.env.PATH ?? ''): string {
  return [...dirs, rest].filter(Boolean).join(path.delimiter);
}
