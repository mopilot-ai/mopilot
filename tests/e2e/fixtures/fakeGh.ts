// Installs the scripted GitHub CLI (fake-gh.mjs) as an executable `gh` in a folder for a test's PATH, with its pull request URL and argv log.
import path from 'node:path';
import { nodeCommand } from './nodeCommand';

export const PR_URL = 'https://github.com/acme/demo/pull/7';

/** Writes `gh` into `dir` (running fake-gh.mjs with this node, with `env` for the test's own answers) and returns the dir and the argv log it appends to. */
export function fakeGhBin(dir: string, env: Record<string, string> = {}) {
  const log = path.join(dir, 'gh.log');
  // a test's own answers (a PR state file, a gate status)
  nodeCommand(dir, 'gh', path.join(__dirname, 'fake-gh.mjs'), { ...env, FAKE_GH_PR_URL: PR_URL, FAKE_GH_LOG: log });
  return { dir, log };
}
