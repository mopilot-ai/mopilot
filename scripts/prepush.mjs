// The pre-push check (.githooks/pre-push): refuses a push that updates or deletes main, which would land commits
// without a pull request or its `unit-tests` status (AGENTS.md). Skip once with `git push --no-verify`.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROTECTED = 'refs/heads/main';

/**
 * The refs this push would change on the remote that are protected, from the lines git passes on standard input
 * (`<local ref> <local oid> <remote ref> <remote oid>`).
 * @param {string} input
 */
export function protectedRefs(input) {
  return input
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[2])
    .filter((ref) => ref === PROTECTED);
}

/**
 * @param {string} input
 * @param {string} remote the remote's name, as git passes it
 * @param {(message: string) => void} [log]
 */
export function prepush(input, remote, log = console.error) {
  if (!protectedRefs(input).length) return 0;
  log(
    `pre-push: refusing to push to main on ${remote}. Changes reach main through a pull request that passed the \`unit-tests\` status (AGENTS.md): push a branch and open one. Skip once with --no-verify.`,
  );
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = prepush(readFileSync(0, 'utf8'), process.argv[2] ?? 'the remote');
}
