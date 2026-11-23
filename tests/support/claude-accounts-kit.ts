// The Claude login identity tests' world: a temp folder standing in for CLAUDE_CONFIG_DIR, and ClaudeAccounts over a
// fake CLI that answers `auth status` as told. Call claudeAccountsWorld before requiring a module that reads the folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** A fetched profile as the CLI writes it to .claude.json: the account, and when it was fetched (if known). */
export const profile = (accountUuid: string, emailAddress: string, profileFetchedAt?: number, more: object = {}) => ({
  oauthAccount: { accountUuid, emailAddress, ...(profileFetchedAt ? { profileFetchedAt } : {}), ...more },
});

/** Lets a few rounds of the accounts' async work run. */
export const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

export function claudeAccountsWorld(prefix: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const shared = path.join(tmp, 'shared');
  fs.mkdirSync(shared, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = shared;
  const { ClaudeAccounts } = require('../../electron/harness/claude/accounts.cjs');
  let n = 0;
  /** A new userData folder's path; `make` creates it. */
  const nextUserData = () => path.join(tmp, `ud-${n++}`);
  /** ClaudeAccounts started on `state`, its CLI answering `auth status` for a login with `status(id)`. */
  function make(state: object, status: (id: string) => object = () => ({ loggedIn: true }), userData = nextUserData()) {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, 'claude-accounts.json'), JSON.stringify(state));
    const events: any[] = [];
    const runs: string[][] = [];
    const run = async (bin: string, args: string[], id: string) => {
      runs.push([bin, ...args, id]);
      return args[1] === 'status' ? JSON.stringify(status(id)) : '';
    };
    const m = new ClaudeAccounts({ userData, broadcast: (e: any) => events.push(e), run });
    m.cliLogin.waitMs = 0;
    return { m, events, runs, userData };
  }
  return { tmp, shared, make, nextUserData };
}
