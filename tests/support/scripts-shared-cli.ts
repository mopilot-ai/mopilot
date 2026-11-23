// Runs one of the repository's scripts as a child process (c8 measures it too). Only for invocations that
// stop before doing anything real: --help, or arguments the script rejects up front.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../../', import.meta.url));

export function runScript(script: string, args: string[] = [], env: Record<string, string | undefined> = {}) {
  const r = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', path.join(REPO, script), ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export const tempDir = (prefix = 'scripts-shared-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** A recorder for injected functions: `calls` keeps every call's arguments. */
export function recorder<T extends (...args: any[]) => any>(impl?: T) {
  const calls: any[][] = [];
  const fn = ((...args: any[]) => {
    calls.push(args);
    return impl?.(...args);
  }) as T & { calls: any[][] };
  fn.calls = calls;
  return fn;
}
