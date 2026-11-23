// Invariant (#1294): the account a Claude Code config names (its oauthAccount) is read for a login only through
// electron/harness/claude/loginIdentity.cjs. The CLI's own ~/.claude.json is shared with other clients (Claude Desktop), so a
// name read from it directly, or from the CLI's accountInfo() that repeats it, can be another account's.
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

/** Where a config's account may be named, and on what condition for each line. */
const ALLOWED: Record<string, (line: string) => boolean> = {
  // the one owner: the server's answer for the CLI's own login, else the config's name with its doubts
  'electron/harness/claude/loginIdentity.cjs': () => true,
  // the reader of the server's answer, in MoPilot's own folder for a login
  'electron/harness/claude/loginReader.cjs': () => true,
  // the login fields a config merge keeps on each side: a field list, not a read
  'electron/harness/claude/configMerge.cjs': (line) => /LOGIN_FIELD|^\s*\/\^\(oauthAccount\|/.test(line),
  // a login's cached plan, read from the file harness/claude/loginIdentity.cjs picks for it
  'electron/harness/claude/accounts.cjs': (line) => /loginFile\(/.test(line) || /^\s*email: a\.emailAddress/.test(line),
};

test("invariant: a config's account is named for a login only through harness/claude/loginIdentity.cjs", () => {
  const found: string[] = [];
  for (const file of sources()) {
    const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/\boauthAccount\b|\bemailAddress\b|\.accountInfo\(/.test(line)) return;
      if (!ALLOWED[file]?.(line)) found.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(found, []);
});

test('the scan finds a direct read, so it would catch one', () => {
  const read = 'const who = readJson(sharedConfig()).oauthAccount;';
  assert.equal(/\boauthAccount\b/.test(read), true);
  assert.equal(ALLOWED['electron/harness/claude/accounts.cjs'](read), false);
  assert.equal(ALLOWED['electron/harness/claude/configMerge.cjs'](read), false);
  assert.equal(
    ALLOWED['electron/harness/claude/accounts.cjs']("    const a = readJson(loginFile(this, id, 'plan'), {}).oauthAccount;"),
    true,
  );
});

/**
 * Inside the owner, a config's name (namedBy) is never the server account a login is (#1582): only these read it, and
 * none of them answers which account a login is.
 */
const NAME_READERS: Record<string, string> = {
  // a doubt about the CLI login's shared name, shown as unverified
  cliLogin: 'doubt',
  // the account an added login was added as: what its own sign-in wrote
  adoptAddedAs: 'added as',
  signedInAs: 'its own sign-in',
  // whether its own config's plan is the account the server named
  planFile: 'compared with the answer',
};

/** The top-level declaration each line that reads a config's name belongs to. */
export function nameReaders(source: string) {
  let owner = '';
  const found: string[] = [];
  for (const line of source.split('\n')) {
    const decl = /^(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*=|class\s+(\w+))/.exec(line);
    if (decl) owner = decl[1] ?? decl[2] ?? decl[3];
    if (/\b(namedBy|identityOf)\(/.test(line) && owner !== 'namedBy') found.push(owner);
  }
  return found;
}

test("invariant: no login's server account is taken from a config's name", () => {
  const source = fs.readFileSync(path.join(root, 'electron/harness/claude/loginIdentity.cjs'), 'utf8');
  const readers = nameReaders(source);
  assert.ok(readers.length > 0, 'the scan still finds the readers');
  assert.deepEqual(
    readers.filter((r) => !(r in NAME_READERS)),
    [],
  );
});

test('the name scan names the declaration a read is in', () => {
  assert.deepEqual(
    nameReaders(
      [
        'const namedBy = (logins, id) => identityOf(readConfigFile(logins.configFile(id)));',
        'function serverIdOf(logins, id) {',
        '  return namedBy(logins, id)?.accountUuid ?? null;',
        '}',
        'const plan = (cfg) => identityOf(cfg)?.accountUuid;',
        'class Reader {',
        '  read() { return namedBy(this, "x"); }',
        '}',
      ].join('\n'),
    ),
    ['serverIdOf', 'plan', 'Reader'],
  );
});
