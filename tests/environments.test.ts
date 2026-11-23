// environment.toml (src/lib/environments.ts): editing the macOS view keeps every other platform's entries (#46).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse as parseToml } from 'smol-toml';

import { environmentOf, stringifyEnvironment } from '../src/lib/environments.ts';
// plain objects, so deepEqual doesn't trip on the parser's prototypes
const parse = (text: string) => JSON.parse(JSON.stringify(parseToml(text)));

const SHARED = `
version = 1
name = "demo"
owner = "team"

[setup]
script = "npm ci"

[[actions]]
name = "Dev"
icon = "run"
command = "npm run dev"

[[actions]]
name = "Dev (Linux)"
icon = "run"
command = "make dev"
platform = "linux"

[[actions]]
name = "Test"
icon = "test"
command = "npm test"
platform = "darwin"
`;

const PER_PLATFORM = `
version = 1
name = "demo"

[setup.darwin]
script = "brew bundle"

[setup.linux]
script = "apt-get install -y foo"

[cleanup.darwin]
script = "rm -rf tmp"

[cleanup.win32]
script = "rd /s tmp"
`;

test('reading keeps the macOS view and the raw file', () => {
  const env = environmentOf(PER_PLATFORM);
  assert.equal(env.setup.script, 'brew bundle');
  assert.equal(env.cleanup?.script, 'rm -rf tmp');
  assert.deepEqual(
    environmentOf(SHARED).actions!.map((a) => a.name),
    ['Dev', 'Test'],
  );
  assert.throws(() => environmentOf('not = [valid'));
});

test('an unchanged environment writes back the same document', () => {
  for (const text of [SHARED, PER_PLATFORM]) assert.deepEqual(parse(stringifyEnvironment(environmentOf(text))), parse(text));
});

test('editing changes only the macOS fields; other platforms and unknown keys stay', () => {
  const env = environmentOf(PER_PLATFORM);
  const out = parse(
    stringifyEnvironment({ ...env, name: 'renamed', setup: { script: 'make setup' }, cleanup: { script: 'make clean' } }),
  ) as any;
  assert.equal(out.name, 'renamed');
  assert.deepEqual(out.setup, { darwin: { script: 'make setup' }, linux: { script: 'apt-get install -y foo' } });
  assert.deepEqual(out.cleanup, { darwin: { script: 'make clean' }, win32: { script: 'rd /s tmp' } });

  const shared = environmentOf(SHARED);
  const edited = parse(
    stringifyEnvironment({ ...shared, setup: { script: 'pnpm i' }, actions: [{ name: 'Dev', icon: 'run', command: 'pnpm dev' }] }),
  ) as any;
  assert.equal(edited.owner, 'team');
  assert.deepEqual(edited.setup, { script: 'pnpm i' });
  // the edited action keeps its slot, the Linux one stays, the removed macOS one goes
  assert.deepEqual(edited.actions, [
    { name: 'Dev', icon: 'run', command: 'pnpm dev' },
    { name: 'Dev (Linux)', icon: 'run', command: 'make dev', platform: 'linux' },
  ]);
});

test('added actions go after the existing ones; a new file gets only what was set', () => {
  const shared = environmentOf(SHARED);
  const more = parse(
    stringifyEnvironment({ ...shared, actions: [...shared.actions!, { name: 'Lint', icon: 'tool', command: 'npm run lint' }] }),
  ) as any;
  assert.deepEqual(
    more.actions.map((a: any) => a.name),
    ['Dev', 'Dev (Linux)', 'Test', 'Lint'],
  );

  const fresh = parse(
    stringifyEnvironment({ version: 1, name: 'new', setup: { script: 'npm ci' }, cleanup: { script: '' }, actions: [] }),
  ) as any;
  assert.deepEqual(fresh, { version: 1, name: 'new', setup: { script: 'npm ci' } });
});
