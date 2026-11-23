// Invariant (#1312): two logins are one account only by their server identity (electron/identity/contract/sameAccount.cjs:
// Claude's accountUuid through harness/claude/loginIdentity.cjs serverIdOf, Codex's workspace and member through codexServerId).
// An email names no account for sure: a team and a personal org share one, and the CLI's shared config can name another
// client's. So no source compares one login's email with another's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { treeFiles } from '../scripts/source-tree.mjs';

export const GUARDS = ['electron/', 'shared/', 'src/'];

const root = path.resolve(import.meta.dirname, '..');
const sources = () =>
  ['electron', 'src', 'shared'].flatMap((d) =>
    treeFiles(path.join(root, d), /\.(c?js|mjs|tsx?)$/)
      .map((p) => path.relative(root, p))
      .filter((p) => !/\.test\./.test(p)),
  );

/** A line that compares an email with an email: `email` just before an equality and just after it. */
export function comparesEmails(line: string) {
  const parts = line.split(/[!=]==/);
  for (let i = 0; i < parts.length - 1; i++) {
    const left = parts[i].slice(-40);
    const right = parts[i + 1].slice(0, 40);
    // a type check, or a comparison with a literal (an input's type 'email'), compares no two emails
    if (/typeof\s+[\w.?]*$/.test(left.trim()) || /^\s*['"`]/.test(right)) continue;
    if (/email/i.test(left) && /email/i.test(right)) return true;
  }
  return false;
}

test('invariant: no source compares two logins by their emails', () => {
  const found: string[] = [];
  for (const file of sources())
    fs.readFileSync(path.join(root, file), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (comparesEmails(line)) found.push(`${file}:${i + 1}: ${line.trim()}`);
      });
  assert.deepEqual(found, []);
});

test('the scan catches the email matches #1312 replaced, and leaves type checks and one-sided lookups alone', () => {
  for (const line of [
    "const sameEmail = (x) => !!email && String(x.email ?? '').toLowerCase() === email;",
    "const same = (a) => a.chatgptAccountId === auth.chatgptAccountId && (a.email || '').toLowerCase() === (email || '').toLowerCase();",
    'if (d.chatgptAccountId && (d.chatgptAccountId !== auth.chatgptAccountId || d.email !== auth.email)) d.limits = null;',
  ])
    assert.equal(comparesEmails(line), true, line);
  for (const line of [
    "email: typeof a.emailAddress === 'string' ? a.emailAddress : null,",
    'const active = useStore((s) => s.claudeAccounts.accounts.find((a) => a.id === s.claudeAccounts.active)?.email ?? null);',
    'const sameAccount = (x) => !!account && serverIdOf(this, x.id) === account;',
    "if (/\\b(username|email)\\b/.test(auto) || type === 'email' || LOGIN_HINT.test(hint)) return 'username';",
  ])
    assert.equal(comparesEmails(line), false, line);
});
