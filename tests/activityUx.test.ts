import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityUx, claudeActivityLabel, claudeActivityParts } from '../src/session/activityUx.ts';
import { commandProgram } from '../src/lib/commandProgram.ts';
import { harnessFamily } from '../src/harness/family.ts';

test('every harness takes the one running look: the accent dots and the activity line', () => {
  assert.equal(activityUx(harnessFamily('claude', 'claude:s')), 'dots');
  assert.equal(activityUx(harnessFamily('codex', 'thread')), 'dots');
  // an ACP id resolves to the Codex owner; a stray claude owner reads the same
  assert.equal(activityUx(harnessFamily('codex', 'acp:kimi:1')), 'dots');
  assert.equal(activityUx(harnessFamily('claude', 'acp:kimi:1')), 'dots');
});

test('activity labels say what Claude Code says: the verb and the program, file, pattern or page it acts on', () => {
  assert.deepEqual(claudeActivityParts({ kind: 'command', item: { command: "python3 - <<'EOF'\nprint(1)\nEOF" } }), {
    verb: 'Running',
    meta: 'python3',
    cut: true,
  });
  assert.equal(claudeActivityLabel({ kind: 'command', item: { command: 'git status' } }), 'Running git status');
  // Codex wraps its commands in the shell: the label names what runs inside
  assert.equal(claudeActivityLabel({ kind: 'command', item: { command: `/bin/zsh -lc 'npm test -- --watch'` } }), 'Running npm test');
  assert.deepEqual(claudeActivityParts({ kind: 'command', item: { command: 'git status' } }), { verb: 'Running', meta: 'git status' });
  // nothing safe to name: the command is "a command"
  assert.equal(claudeActivityLabel({ kind: 'command', item: { command: 'curl -H "Authorization: Bearer x" h' } }), 'Running a command');
  assert.equal(claudeActivityLabel({ kind: 'command', item: {} }), 'Running a command');
  // the model's own description wins, in the running form, or as written when it does not start with a verb
  assert.deepEqual(claudeActivityParts({ kind: 'command', item: { command: 'rm -rf x', description: ' Run the tests ' } }), {
    verb: 'Running the tests',
  });
  assert.equal(
    claudeActivityLabel({ kind: 'command', item: { command: 'ls', description: 'Tests for the parser' } }),
    'Tests for the parser',
  );
  assert.equal(claudeActivityLabel({ kind: 'command', item: { command: 'ls', description: '  ' } }), 'Running ls');
  assert.equal(claudeActivityLabel(undefined), 'Thinking');
  assert.equal(claudeActivityLabel({ kind: 'reasoning', item: { summary: ['**Planning**'] } }), 'Thinking');
  assert.equal(claudeActivityLabel({ kind: 'read', item: {}, path: '/repo/src/a.ts' }), 'Reading a.ts');
  assert.equal(claudeActivityLabel({ kind: 'read', item: {} }), 'Reading');
  assert.equal(claudeActivityLabel({ kind: 'search', item: {}, query: 'TODO' }), 'Searching TODO');
  assert.equal(claudeActivityLabel({ kind: 'search', item: {}, query: '  ' }), 'Searching');
  // a search parsed without its pattern carries the whole command: not quoted
  assert.equal(claudeActivityLabel({ kind: 'search', item: { command: 'rg -n foo src' }, query: 'rg -n foo src' }), 'Searching');
  assert.equal(claudeActivityLabel({ kind: 'list', item: {}, path: 'src' }), 'Listing src');
  assert.equal(claudeActivityLabel({ kind: 'list', item: {}, path: null }), 'Listing');
  assert.equal(claudeActivityLabel({ kind: 'edit', item: {}, change: { path: '/r/b.ts', kind: { type: 'update' } } }), 'Editing b.ts');
  assert.equal(claudeActivityLabel({ kind: 'edit', item: {}, change: { path: '/r/c.ts', kind: { type: 'add' } } }), 'Creating c.ts');
  assert.equal(claudeActivityLabel({ kind: 'edit', item: {} }), 'Editing');
  assert.equal(
    claudeActivityLabel({ kind: 'web', item: { action: { type: 'openPage', url: 'https://x.dev' } } }),
    'Fetching https://x.dev',
  );
  assert.equal(claudeActivityLabel({ kind: 'web', item: { query: 'q', action: { type: 'search' } } }), 'Searching web q');
  assert.equal(
    claudeActivityLabel({ kind: 'tool', item: { server: 'claude-in-chrome', tool: 'navigate' } }),
    'Using claude-in-chrome: navigate',
  );
  assert.equal(
    claudeActivityLabel({ kind: 'tool', item: { server: 'github', tool: 'create_pull_request' } }),
    'Using github: create pull request',
  );
  assert.equal(claudeActivityLabel({ kind: 'tool', item: { server: 'github' } }), 'Using github');
  assert.equal(claudeActivityLabel({ kind: 'tool', item: { server: '', tool: 'x' } }), 'Using x');
  assert.equal(
    claudeActivityLabel({ kind: 'tool', item: { server: '', tool: 'Skill', arguments: { skill: 'fix-bug' } } }),
    'Running skill /fix-bug',
  );
  assert.equal(claudeActivityLabel({ kind: 'agent', item: { description: 'Find the bug' } }), 'Finding the bug');
  assert.equal(claudeActivityLabel({ kind: 'agent', item: { agent: { description: 'Fix the diff' } } }), 'Fixing the diff');
  assert.equal(claudeActivityLabel({ kind: 'agent', item: { prompt: 'Review the diff' } }), 'Review the diff', 'not a verb it knows');
  assert.equal(claudeActivityLabel({ kind: 'agent', item: {} }), 'Running agent');
  assert.equal(claudeActivityLabel({ kind: 'other', item: {} }), 'Working');
  // a step whose item has not arrived yet still gets a label
  assert.equal(claudeActivityLabel({ kind: 'web', item: undefined }), 'Searching web');
  assert.equal(claudeActivityLabel({ kind: 'tool', item: null }), 'Using a tool');
});

test('a command is named by its program and up to three plain words, never by a credential', () => {
  const named = (c: string) => commandProgram(c);
  assert.deepEqual(named('npm run test:coverage -- --changed'), { text: 'npm run test:coverage', cut: true });
  assert.deepEqual(named('git status'), { text: 'git status', cut: false });
  assert.deepEqual(named('ls a b c d e'), { text: 'ls a b c', cut: true });
  // the `cd dir &&` hops before the program are not it
  assert.deepEqual(named("cd /repo && cd 'my dir' ; make build"), { text: 'make build', cut: false });
  // a continued first line, a heredoc, a long command: shortened
  assert.deepEqual(named('docker run \\\n  --rm x'), { text: 'docker run', cut: true });
  assert.deepEqual(named('cat <<EOF\nhi\nEOF'), { text: 'cat', cut: true });
  assert.deepEqual(named(`echo ${'a'.repeat(9000)}`), { text: 'echo', cut: true });
  assert.deepEqual(named('  \tnode\tx.js'), { text: 'node x.js', cut: false });
  assert.deepEqual(named('npm i left-pad@1.3.0'), { text: 'npm i left-pad@1.3.0', cut: false });
  assert.deepEqual(named('npm i @scope/pkg'), { text: 'npm i @scope/pkg', cut: false });
  // nothing to name
  for (const c of ['', '   ', '-x', '"quoted" x', 'echo $(whoami)', 'diff <(a) <(b)', 'echo `id`']) assert.equal(named(c), null, c);
  // a credential anywhere hides the whole command
  for (const c of [
    'git clone https://user:pw@host/r',
    'curl -u admin:hunter2 https://h',
    'curl -H "Authorization: x"',
    'sshpass -p x ssh h',
    'mysql -u root -psecret',
    'GITHUB_TOKEN=abc gh pr list',
  ])
    assert.equal(named(c), null, c);
  // words that point somewhere private stop the name there
  assert.deepEqual(named('curl example.com/x'), { text: 'curl', cut: true });
  assert.deepEqual(named('nc localhost:8080'), { text: 'nc', cut: true });
  assert.deepEqual(named('open http%3A'), { text: 'open', cut: true });
  assert.deepEqual(named('use abcdefghij1234567890xyz'), { text: 'use', cut: true });
  assert.deepEqual(named('cat .env.secret'), { text: 'cat', cut: true });
  assert.deepEqual(named('cat api-key.txt'), { text: 'cat', cut: true });
  assert.deepEqual(named('cat my.api'), { text: 'cat my.api', cut: false });
  // a flag named like a secret is not one
  assert.deepEqual(named('node bench.js --max-tokens=500'), { text: 'node bench.js', cut: true });
  assert.deepEqual(named('ssh me@host'), { text: 'ssh me@host', cut: false });
  assert.deepEqual(named('ssh me@host:22'), { text: 'ssh', cut: true });
  assert.deepEqual(named('mail a@b.example'), { text: 'mail', cut: true });
});

test('a loop, test or group is named by the first program inside it, never by its shell syntax', () => {
  const named = (c: string) => commandProgram(c);
  // the reported line: a Codex polling loop read as "Running for i in 1…"
  assert.deepEqual(named('for i in 1 2 3 4 5; do gh pr view 12 && break; sleep 10; done'), { text: 'gh pr view 12', cut: true });
  assert.equal(
    claudeActivityLabel({ kind: 'command', item: { command: `/bin/zsh -lc 'for i in 1 2 3; do curl -s x.dev/h; done'` } }),
    'Running curl',
  );
  // a bare condition (`true`, `[ … ]`, `test`) is not the program; the body is
  assert.deepEqual(named('while true; do npm test; sleep 2; done'), { text: 'npm test', cut: true });
  assert.deepEqual(named('if [ -f x ]; then make build; fi'), { text: 'make build', cut: true });
  assert.deepEqual(named('until test -s out; do node poll.js; done'), { text: 'node poll.js', cut: true });
  // a condition that runs something is what runs first
  assert.deepEqual(named('if ! grep -q x f; then echo no; fi'), { text: 'grep', cut: true });
  // a loop written over several lines, after `cd` hops, in a group
  assert.deepEqual(named('cd /repo && for f in a b\ndo\n  npm run lint\ndone'), { text: 'npm run lint', cut: true });
  assert.deepEqual(named('{ git fetch; git status; }'), { text: 'git fetch', cut: true });
  assert.deepEqual(named('case $x in a) make a ;; esac'), null);
  // a `cd` hop inside the body is not the program; `time` and `!` before a plain command keep its whole name
  assert.deepEqual(named('for d in a b; do cd "$d" && npm test; done'), { text: 'npm test', cut: true });
  assert.deepEqual(named('( cd web && npm run build )'), { text: 'npm run build', cut: true });
  assert.deepEqual(named('time npm test'), { text: 'time npm test', cut: false });
  // a function's definition runs nothing: what runs is the call, or the command after it
  assert.deepEqual(named('function f { rm -rf build; }; echo ok'), { text: 'echo ok', cut: true });
  assert.deepEqual(named('function retry { curl -s x; sleep 1; }; retry'), { text: 'retry', cut: true });
  assert.deepEqual(named('f() { rm -rf build; }; npm test'), { text: 'npm test', cut: true });
  assert.equal(named('f() { rm -rf build; }'), null);
  // a long body cut by the read limit: its last, partial word is not named
  assert.deepEqual(named(`for i in 1; do ${'a'.repeat(9000)}`), null);
  assert.deepEqual(named(`for i in 1; do echo ${'a'.repeat(9000)}`), { text: 'echo', cut: true });
  // nothing safe inside: the command is "a command", not its syntax
  for (const c of ['for i in 1 2; do "$i"; done', 'while :; do :; done', 'for i in 1 2 3', 'for f in "a;b"; do x; done'])
    assert.equal(named(c), null, c);
  assert.equal(claudeActivityLabel({ kind: 'command', item: { command: 'for i in 1 2 3; do "$i"; done' } }), 'Running a command');
});
