// environment.toml (src/lib/environments.ts) on Windows, sparse files, and the read/write through the native port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installNativeStub } from './support/ports/native.ts';

const reads: string[] = [];
const writes: [string, string][] = [];
let writeResult: { ok: boolean; error?: string } = { ok: true };
let fileText: string | null = null;
const resolves: string[] = [];
const converts: string[] = [];
let resolved: any = null;
let convertResult: { ok: boolean; file?: string; error?: string } = { ok: true, file: '/r/.codex/environments/environment.toml' };
const win = {
  native: {
    platform: 'win32',
    fs: { readText: async (p: string) => (reads.push(p), fileText) },
    env: {
      write: async (root: string, text: string) => (writes.push([root, text]), writeResult),
      resolve: async (root: string) => (resolves.push(root), resolved),
      convert: async (root: string) => (converts.push(root), convertResult),
    },
  },
};
// the bridge environments.ts reads, installed in the native port (src/lib/native.ts)
installNativeStub(win.native);
// the bridge's types for these calls (a module of declarations)
await import('../src/lib/native/env.ts');
const { environmentOf, readEnvironment, stringifyEnvironment, writeEnvironment, resolveEnvironment, convertEnvironment } = await import(
  '../src/lib/environments.ts'
);

test('the Windows view reads win32 scripts and actions, else the shared script', () => {
  const env = environmentOf(
    '[setup.win32]\nscript = "choco install"\n[cleanup]\n[[actions]]\nname = "Mac"\ncommand = "x"\nplatform = "darwin"\n[[actions]]\nname = "Win"\ncommand = "y"\nplatform = "win32"\n',
  );
  assert.equal(env.setup.script, 'choco install');
  assert.equal(env.cleanup?.script, '');
  assert.deepEqual(
    env.actions!.map((a) => a.name),
    ['Win'],
  );
});

test('a sparse file gets defaults, and writing without cleanup or actions leaves them out', () => {
  const env = environmentOf('');
  assert.deepEqual(
    { ...env, raw: undefined },
    { version: 1, name: '', setup: { script: '' }, cleanup: undefined, actions: [], raw: undefined },
  );
  assert.deepEqual(
    stringifyEnvironment({ version: 0, name: 'n', setup: { script: 's' } })
      .trim()
      .split('\n'),
    ['version = 1', 'name = "n"', '', '[setup]', 'script = "s"'],
  );
  // an existing cleanup table is kept even when this platform has no cleanup script
  assert.match(
    stringifyEnvironment({ version: 2, name: 'n', setup: { script: 's' }, raw: { cleanup: { linux: { script: 'l' } } } }),
    /\[cleanup\]\nscript = ""/,
  );
});

test('reading and writing go through window.native', async () => {
  (globalThis as any).window = win;
  try {
    assert.equal(await readEnvironment('/r'), null);
    fileText = 'name = "x"';
    assert.equal((await readEnvironment('/r'))?.name, 'x');
    assert.deepEqual(reads, ['/r/.codex/environments/environment.toml', '/r/.codex/environments/environment.toml']);
    // a file that is there but isn't valid TOML is not taken for none: the editor would open blank and Save replace it
    fileText = '[setup\nscript = "x"';
    await assert.rejects(readEnvironment('/r'), /environment\.toml isn't valid TOML \(.+\)\. Fix it in a text editor$/);
    fileText = 'name = "x"';
    await writeEnvironment('/r', { version: 1, name: 'x', setup: { script: '' } });
    assert.equal(writes[0][0], '/r');
    assert.match(writes[0][1], /name = "x"/);
    writeResult = { ok: false, error: 'denied' };
    await assert.rejects(writeEnvironment('/r', { version: 1, name: 'x', setup: { script: '' } }), /Couldn't save the environment: denied/);
  } finally {
    delete (globalThis as any).window;
  }
});

test("the resolved environment is main's answer; an unreadable environment.toml rejects, unreadable Conductor config does not", async () => {
  resolved = {
    source: 'conductor',
    setup: 'pnpm i',
    cleanup: '',
    actions: [],
    error: null,
    notice: "Found Conductor config we couldn't read: x",
  };
  assert.equal(await resolveEnvironment('/r'), resolved);
  assert.deepEqual(resolves, ['/r']);
  resolved = {
    source: 'environment',
    setup: '',
    error: "/r/.codex/environments/environment.toml isn't valid TOML (bad). Fix it in a text editor",
  };
  await assert.rejects(resolveEnvironment('/r'), /isn't valid TOML \(bad\)\. Fix it in a text editor$/);
});

test('converting asks main, and a refusal says why', async () => {
  await convertEnvironment('/r');
  assert.deepEqual(converts, ['/r']);
  convertResult = { ok: false, error: '/r/.codex/environments/environment.toml already exists' };
  await assert.rejects(convertEnvironment('/r'), /^Error: Couldn't convert the Conductor config: .+environment\.toml already exists$/);
});
