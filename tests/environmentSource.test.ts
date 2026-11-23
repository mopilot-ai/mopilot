// electron/platform/environmentSource.cjs: which file supplies a repository's setup script, cleanup script, actions and
// files to copy (environment.toml, Conductor's settings, legacy conductor.json), what a broken file does, and the
// readers that go through it (setupScriptOf, the env:resolve and env:convert IPC).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { resolveEnvironment, convertToEnvironment } = require('../electron/platform/environmentSource.cjs');
const { setupScriptOf } = require('../electron/platform/chatStart.cjs');
const { register } = require('../electron/app/ipc/environment.cjs');

function repoWith(t: any, files: Record<string, string>) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'env-source-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}
const ENV = '.codex/environments/environment.toml';
const LOCAL = '.conductor/settings.local.toml';
const SHARED = '.conductor/settings.toml';
const JSON_FILE = 'conductor.json';
const NONE = {
  setup: '',
  cleanup: '',
  actions: [],
  copy: [],
  copySource: null,
  copyError: null,
  source: null,
  files: [],
  error: null,
  unreadable: [],
  notice: '',
};

test('a repository with no config resolves to nothing, from no source', (t) => {
  assert.deepEqual(resolveEnvironment(repoWith(t, {})), NONE);
  assert.deepEqual(resolveEnvironment(path.join(repoWith(t, {}), 'missing')), NONE);
});

test('precedence: environment.toml, then Conductor local over shared, then conductor.json', (t) => {
  const all = {
    [ENV]: '[setup]\nscript = "own"\n',
    [LOCAL]: '[scripts]\nsetup = "local"\n',
    [SHARED]: '[scripts]\nsetup = "shared"\narchive = "shared-archive"\n',
    [JSON_FILE]: '{"scripts":{"setup":"legacy","archive":"legacy-archive"}}',
  };
  const pick = (...names: string[]) => Object.fromEntries(names.map((n) => [n, all[n]]));
  const of = (...names: string[]) => {
    const repo = repoWith(t, pick(...names));
    const r = resolveEnvironment(repo, 'darwin');
    return [r.source, r.setup, r.cleanup, r.files.map((f: string) => path.relative(repo, f))];
  };
  assert.deepEqual(of(ENV, LOCAL, SHARED, JSON_FILE), ['environment', 'own', '', [ENV]]);
  assert.deepEqual(of(ENV, JSON_FILE), ['environment', 'own', '', [ENV]]);
  // a key the local file sets wins; one it leaves alone is the shared file's; the legacy file is ignored
  assert.deepEqual(of(LOCAL, SHARED, JSON_FILE), ['conductor', 'local', 'shared-archive', [LOCAL, SHARED]]);
  assert.deepEqual(of(SHARED, JSON_FILE), ['conductor', 'shared', 'shared-archive', [SHARED]]);
  assert.deepEqual(of(LOCAL, JSON_FILE), ['conductor', 'local', '', [LOCAL]]);
  assert.deepEqual(of(JSON_FILE), ['conductor-json', 'legacy', 'legacy-archive', [JSON_FILE]]);
});

test("environment.toml: this platform's scripts and actions, else the shared ones", (t) => {
  const repo = repoWith(t, {
    [ENV]: [
      'name = "x"',
      '[setup]\nscript = " make "\n[setup.win32]\nscript = "ps"',
      '[cleanup]\nscript = "rm -rf tmp"',
      '[[actions]]\nname = "Dev"\nicon = "debug"\ncommand = "npm run dev"',
      '[[actions]]\nname = "Win"\nicon = "rocket"\ncommand = "dev.cmd"\nplatform = "win32"',
      '[[actions]]\nplatform = "darwin"',
    ].join('\n'),
  });
  const mac = resolveEnvironment(repo, 'darwin');
  assert.deepEqual([mac.setup, mac.cleanup], ['make', 'rm -rf tmp']);
  assert.deepEqual(mac.actions, [
    { name: 'Dev', icon: 'debug', command: 'npm run dev' },
    { name: '', icon: null, command: '', platform: 'darwin' },
  ]);
  const win = resolveEnvironment(repo, 'win32');
  assert.deepEqual([win.setup, win.cleanup], ['ps', 'rm -rf tmp']);
  assert.deepEqual(win.actions, [
    { name: 'Dev', icon: 'debug', command: 'npm run dev' },
    { name: 'Win', icon: null, command: 'dev.cmd', platform: 'win32' },
  ]);
  // a sparse file, and one whose actions are not a list of tables
  const sparse = resolveEnvironment(repoWith(t, { [ENV]: 'name = "x"\nactions = [1, "two"]\n' }));
  assert.deepEqual([sparse.source, sparse.setup, sparse.cleanup, sparse.actions], ['environment', '', '', []]);
  assert.deepEqual(resolveEnvironment(repoWith(t, { [ENV]: 'actions = "none"\n' })).actions, []);
});

test('an environment.toml that is there but unreadable owns the answer: an error, never Conductor scripts', (t) => {
  const bad = repoWith(t, {
    [ENV]: 'name = [oops\n',
    [SHARED]: '[scripts]\nsetup = "conductor"\n',
  });
  const r = resolveEnvironment(bad);
  assert.deepEqual([r.source, r.setup, r.actions], ['environment', '', []]);
  assert.match(r.error, /environment\.toml isn't valid TOML \(.+\)\. Fix it in a text editor$/);
  assert.doesNotMatch(r.error, /\n/);
  assert.throws(() => setupScriptOf(bad), /isn't valid TOML/);
  // a folder where the file should be
  const dir = repoWith(t, { [`${ENV}/x`]: '' });
  assert.match(resolveEnvironment(dir).error, /EISDIR/);
  assert.equal(resolveEnvironment(dir).source, 'environment');
});

test('Conductor run scripts become run actions: per-id tables, local overrides by id, and the legacy command', (t) => {
  const repo = repoWith(t, {
    [SHARED]: [
      '"$schema" = "https://conductor.build/schemas/settings.repo.schema.json"',
      'enterprise_data_privacy = true',
      '[scripts]\nsetup = """\npnpm install\npnpm build\n"""\nrun_mode = "nonconcurrent"\nfuture_key = 1',
      '[scripts.run.web]\navailable_in = [ "local", "cloud" ]\ncommand = "pnpm dev --port $CONDUCTOR_PORT"\nicon = "play"',
      '[scripts.run.worker]\navailable_in = "local"\ncommand = " pnpm worker "\nargs = ["--name", "it\'s mine", 7]\ndefault = true',
      '[scripts.run.cloud]\navailable_in = "cloud"\ncommand = "cloud-only"',
      '[scripts.run.cloudlist]\navailable_in = ["cloud"]\ncommand = "cloud-only"',
      '[scripts.run.hidden]\ncommand = "shared-hidden"',
      '[scripts.run.nocommand]\nicon = "server"',
      '[scripts.run.blank]\ncommand = "  "',
      '[scripts.run.api]\ncommand = "pnpm api"\n[scripts.run.api.options]\ncwd = "apps/my api"',
      '[scripts.run.plaincwd]\ncommand = "x"\noptions = { cwd = "apps/api" }',
      '[scripts.run.badcwd]\ncommand = "y"\noptions = { cwd = 3 }',
      '[scripts.run.emptycwd]\ncommand = "z"\noptions = { cwd = "" }',
      '[scripts.run.badoptions]\ncommand = "w"\noptions = "here"\nargs = "nope"',
    ].join('\n'),
    [LOCAL]: '[scripts.run.hidden]\nhide = true\n[scripts.run.web]\ncommand = "pnpm dev:mine"\n[scripts.run.mine]\ncommand = "just me"\n',
  });
  const r = resolveEnvironment(repo, 'darwin');
  assert.equal(r.setup, 'pnpm install\npnpm build');
  assert.deepEqual(r.unreadable, []);
  assert.deepEqual(r.actions, [
    {
      name: 'worker',
      icon: 'run',
      command: "pnpm worker --name 'it'\\''s mine'",
      platform: 'darwin',
    },
    { name: 'web', icon: 'run', command: 'pnpm dev:mine' },
    { name: 'api', icon: 'run', command: "cd -- 'apps/my api' && pnpm api", platform: 'darwin' },
    { name: 'plaincwd', icon: 'run', command: 'cd -- apps/api && x', platform: 'darwin' },
    { name: 'badcwd', icon: 'run', command: 'y' },
    { name: 'emptycwd', icon: 'run', command: 'z' },
    { name: 'badoptions', icon: 'run', command: 'w' },
    { name: 'mine', icon: 'run', command: 'just me' },
  ]);
  // Windows runs actions in PowerShell: its quoting, and no `&&`
  assert.deepEqual(
    resolveEnvironment(repo, 'win32')
      .actions.filter((a: any) => ['worker', 'api'].includes(a.name))
      .map((a: any) => a.command),
    ["pnpm worker '--name' 'it''s mine'", "Set-Location -LiteralPath 'apps/my api'; if ($?) { pnpm api }"],
  );
  const legacy = (files: Record<string, string>) => resolveEnvironment(repoWith(t, files)).actions;
  assert.deepEqual(
    legacy({
      [SHARED]: '[scripts]\nrun = " pnpm dev "\nrun_mode = "concurrent"\n',
    }),
    [{ name: 'Run', icon: 'run', command: 'pnpm dev' }],
  );
  assert.deepEqual(legacy({ [SHARED]: '[scripts]\nrun = ""\n' }), []);
  // a local file in the other shape replaces the shared run scripts whole
  assert.deepEqual(
    legacy({
      [SHARED]: '[scripts.run.web]\ncommand = "a"\n',
      [LOCAL]: '[scripts]\nrun = "b"\n',
    }),
    [{ name: 'Run', icon: 'run', command: 'b' }],
  );
  assert.deepEqual(
    legacy({
      [SHARED]: '[scripts]\nrun = "a"\n',
      [LOCAL]: '[scripts.run.web]\ncommand = "b"\n',
    }),
    [{ name: 'web', icon: 'run', command: 'b' }],
  );
});

test('legacy conductor.json: scripts.setup, scripts.run and scripts.archive as strings, other keys ignored', (t) => {
  const repo = repoWith(t, {
    [JSON_FILE]: JSON.stringify({
      scripts: {
        setup: 'npm install',
        run: 'npm run dev',
        archive: './archive.sh',
      },
      runScriptMode: 'concurrent',
      enterpriseDataPrivacy: true,
      someday: {},
    }),
  });
  assert.deepEqual(resolveEnvironment(repo), {
    ...NONE,
    setup: 'npm install',
    cleanup: './archive.sh',
    actions: [{ name: 'Run', icon: 'run', command: 'npm run dev' }],
    copy: ['.env*'],
    copySource: 'default',
    source: 'conductor-json',
    files: [path.join(repo, JSON_FILE)],
  });
  // `.conductor` that is a file is not a settings folder: the legacy file still counts
  assert.equal(resolveEnvironment(repoWith(t, { '.conductor': '', [JSON_FILE]: '{}' })).source, 'conductor-json');
});

test('Conductor config that cannot be read is reported, and never empties or fails the answer in silence', (t) => {
  // a broken local file: the shared one is used, and the caller is told
  const partial = repoWith(t, {
    [LOCAL]: '[scripts\n',
    [SHARED]: '[scripts]\nsetup = "shared"\n',
    [JSON_FILE]: '{"scripts":{"setup":"old"}}',
  });
  const p = resolveEnvironment(partial);
  assert.deepEqual([p.source, p.setup, p.files], ['conductor', 'shared', [path.join(partial, SHARED)]]);
  assert.equal(p.unreadable.length, 1);
  assert.equal(p.unreadable[0].file, path.join(partial, LOCAL));
  assert.match(p.notice, /^Found Conductor config we couldn't read: .+settings\.local\.toml \(.+\)$/);
  const warned: any[] = [];
  assert.equal(
    setupScriptOf(partial, 'darwin', (...a: any[]) => warned.push(a)),
    'shared',
  );
  assert.equal(warned.length, 1);
  assert.equal(warned[0][1].message, p.notice);
  // with nothing to report, nothing is warned
  assert.equal(
    setupScriptOf(repoWith(t, { [SHARED]: '[scripts]\nsetup = "ok"\n' }), 'darwin', () => assert.fail('warned')),
    'ok',
  );
  // the default warning records the notice and still returns
  assert.equal(setupScriptOf(partial), 'shared');

  // both TOML files broken: still Conductor's (its stale conductor.json is not run instead), empty, and said so
  const broken = repoWith(t, {
    [LOCAL]: '= 1\n',
    [SHARED]: 'x = [\n',
    [JSON_FILE]: '{"scripts":{"setup":"old"}}',
  });
  const b = resolveEnvironment(broken);
  assert.deepEqual([b.source, b.setup, b.files, b.unreadable.length], ['conductor', '', [], 2]);
  assert.match(b.notice, /settings\.local\.toml .+; .+settings\.toml/);
  assert.deepEqual(convertToEnvironment(broken), {
    ok: false,
    error: b.notice,
  });

  // a settings file that is a folder
  const folder = resolveEnvironment(repoWith(t, { [`${SHARED}/x`]: '' }));
  assert.equal(folder.source, 'conductor');
  assert.match(folder.unreadable[0].reason, /EISDIR/);

  // malformed and wrongly shaped JSON
  for (const text of ['{"scripts":', '[]', '"npm install"', 'null']) {
    const j = resolveEnvironment(repoWith(t, { [JSON_FILE]: text }));
    assert.deepEqual([j.source, j.setup, j.unreadable.length], ['conductor-json', '', 1], text);
    assert.match(j.notice, /conductor\.json/);
  }
  assert.match(resolveEnvironment(repoWith(t, { [JSON_FILE]: '[]' })).unreadable[0].reason, /not a table of settings/);
});

test('a known Conductor key of the wrong type is reported; the keys that are right still apply', (t) => {
  const reasons = (toml: string) => resolveEnvironment(repoWith(t, { [SHARED]: toml })).unreadable.map((u: any) => u.reason);
  assert.deepEqual(reasons('scripts = "npm install"\n'), ['`scripts` is not a table']);
  assert.deepEqual(reasons('[scripts]\nsetup = ["a"]\narchive = 3\nrun = 4\n'), [
    '`scripts.setup` is not a string',
    '`scripts.archive` is not a string',
    '`scripts.run` is neither a command nor a table of actions',
  ]);
  assert.deepEqual(reasons('file_include_globs = 3\n'), ['`file_include_globs` is not a list of patterns']);
  assert.deepEqual(reasons('file_include_globs = [".env", 3]\n'), ['`file_include_globs` is not a list of patterns']);
  const mixed = resolveEnvironment(
    repoWith(t, {
      [SHARED]: '[scripts]\nsetup = "ok"\n[scripts.run]\nweb = "pnpm dev"\napi = { command = "pnpm api" }\n',
    }),
  );
  assert.deepEqual(
    mixed.unreadable.map((u: any) => u.reason),
    ['`scripts.run.web` is not a table'],
  );
  assert.deepEqual([mixed.setup, mixed.actions], ['ok', [{ name: 'api', icon: 'run', command: 'pnpm api' }]]);
  // a local command of the wrong type is reported, and the shared action it would have replaced still runs
  const wrong = resolveEnvironment(
    repoWith(t, { [SHARED]: '[scripts.run.web]\ncommand = "pnpm dev"\n', [LOCAL]: '[scripts.run.web]\ncommand = 5\nicon = "play"\n' }),
  );
  assert.deepEqual(
    wrong.unreadable.map((u: any) => u.reason),
    ['`scripts.run.web.command` is not a string'],
  );
  assert.deepEqual(wrong.actions, [{ name: 'web', icon: 'run', command: 'pnpm dev' }]);
});

test('files to copy: .worktreeinclude, else file_include_globs, else .env* where Conductor config exists', (t) => {
  const copy = (files: Record<string, string>) => {
    const r = resolveEnvironment(repoWith(t, files));
    return [r.copy, r.copySource];
  };
  const globs = 'file_include_globs = """\n.env.local\n\n# certificates\n  certs/local/**  \n!certs/local/ca.pem\n"""\n';
  assert.deepEqual(copy({ [SHARED]: globs }), [['.env.local', 'certs/local/**', '!certs/local/ca.pem'], 'conductor']);
  assert.deepEqual(copy({ [SHARED]: 'file_include_globs = [".env", "config/*.json"]\n' }), [['.env', 'config/*.json'], 'conductor']);
  assert.deepEqual(copy({ [SHARED]: globs, [LOCAL]: 'file_include_globs = "mine/**"\n' }), [['mine/**'], 'conductor']);
  assert.deepEqual(copy({ [SHARED]: '[scripts]\nsetup = "x"\n' }), [['.env*'], 'default']);
  assert.deepEqual(
    copy({
      [SHARED]: globs,
      '.worktreeinclude': '# mine\r\n.env\r\n\r\nsecrets/**\r\n',
    }),
    [['.env', 'secrets/**'], 'worktreeinclude'],
  );
  // the root file is read with no Conductor config too, and an empty one copies nothing
  assert.deepEqual(copy({ '.worktreeinclude': '.env\n' }), [['.env'], 'worktreeinclude']);
  assert.deepEqual(copy({ [SHARED]: globs, '.worktreeinclude': '' }), [[], 'worktreeinclude']);
  assert.deepEqual(copy({}), [[], null]);
});

test('the files to copy do not depend on which file supplies the scripts, so converting keeps them', (t) => {
  const kept = resolveEnvironment(
    repoWith(t, {
      [ENV]: '[setup]\nscript = "own"\n',
      [SHARED]: 'file_include_globs = ".env.local"\n[scripts]\nsetup = "c"\n',
    }),
  );
  assert.deepEqual([kept.source, kept.setup, kept.copy, kept.copySource], ['environment', 'own', ['.env.local'], 'conductor']);
  // Conductor's files still decide the copy list: one that can't be read is reported
  const relied = resolveEnvironment(repoWith(t, { [ENV]: '[setup]\nscript = "own"\n', [SHARED]: 'x = [\n' }));
  assert.deepEqual([relied.setup, relied.copy, relied.copySource, relied.unreadable.length], ['own', ['.env*'], 'default', 1]);
  assert.match(relied.notice, /settings\.toml/);
  assert.equal(relied.error, null);
  // .worktreeinclude decides it: Conductor's broken file supplies nothing here and is not this repository's problem
  const own = resolveEnvironment(
    repoWith(t, {
      [ENV]: '[setup]\nscript = "own"\n',
      [SHARED]: 'x = [\n',
      '.worktreeinclude': '.env\n',
    }),
  );
  assert.deepEqual([own.copy, own.unreadable, own.notice], [['.env'], [], '']);
  // a .worktreeinclude that can't be read is its own report (not Conductor's), whoever supplies the scripts: the next
  // source of the list is used, no notice is raised, and converting is not held up
  for (const [files, copySource] of [
    [{ [ENV]: 'name = "x"\n' }, null],
    [{ [SHARED]: '[scripts]\nsetup = "c"\n' }, 'default'],
    [{}, null],
  ] as [Record<string, string>, string | null][]) {
    const repo = repoWith(t, { ...files, '.worktreeinclude/x': '' });
    const r = resolveEnvironment(repo);
    assert.match(r.copyError, /\.worktreeinclude couldn't be read \(EISDIR/);
    assert.ok(r.copyError.startsWith(path.join(repo, '.worktreeinclude')));
    assert.deepEqual([r.copySource, r.unreadable, r.notice], [copySource, [], '']);
    assert.equal(convertToEnvironment(repo).ok, copySource === 'default');
  }
});

test('convert writes environment.toml from the Conductor config, which then resolves to the same scripts', (t) => {
  const repo = repoWith(t, {
    [SHARED]: '[scripts]\nsetup = "pnpm install"\narchive = "./archive.sh"\n[scripts.run.web]\ncommand = "pnpm dev"\n',
    '.worktreeinclude': '.env\n',
  });
  const before = resolveEnvironment(repo, 'darwin');
  assert.deepEqual(convertToEnvironment(repo, 'darwin'), {
    ok: true,
    file: path.join(repo, ENV),
  });
  const text = fs.readFileSync(path.join(repo, ENV), 'utf8');
  assert.match(text, new RegExp(`^version = 1\\nname = "${path.basename(repo)}"\\n`));
  assert.deepEqual(resolveEnvironment(repo, 'darwin'), {
    ...before,
    source: 'environment',
    files: [path.join(repo, ENV)],
  });
  // Conductor's files are left as they were, and a second convert never overwrites
  assert.match(fs.readFileSync(path.join(repo, SHARED), 'utf8'), /pnpm install/);
  assert.deepEqual(convertToEnvironment(repo), {
    ok: false,
    error: `${path.join(repo, ENV)} already exists`,
  });
  assert.equal(fs.readFileSync(path.join(repo, ENV), 'utf8'), text);

  // an action written in this platform's shell syntax says so in the converted file, and other platforms leave it out
  const shelled = repoWith(t, { [SHARED]: '[scripts.run.api]\ncommand = "pnpm api"\noptions = { cwd = "apps/my api" }\n' });
  assert.equal(convertToEnvironment(shelled, 'darwin').ok, true);
  assert.deepEqual(resolveEnvironment(shelled, 'darwin').actions, [
    { name: 'api', icon: 'run', command: "cd -- 'apps/my api' && pnpm api", platform: 'darwin' },
  ]);
  assert.deepEqual(resolveEnvironment(shelled, 'win32').actions, []);

  // a setup script alone: no empty cleanup table and no actions list
  const bare = repoWith(t, { [JSON_FILE]: '{"scripts":{"setup":"npm ci"}}' });
  assert.equal(convertToEnvironment(bare).ok, true);
  assert.doesNotMatch(fs.readFileSync(path.join(bare, ENV), 'utf8'), /cleanup|actions/);
  assert.equal(resolveEnvironment(bare).setup, 'npm ci');

  assert.deepEqual(convertToEnvironment(repoWith(t, {})), {
    ok: false,
    error: 'This project has no Conductor config to convert',
  });
  // the file can't be made: said, not thrown
  const blocked = convertToEnvironment(repoWith(t, { [SHARED]: '[scripts]\nsetup = "x"\n', '.codex': '' }));
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /ENOTDIR|EEXIST/);
});

test('a run script whose id is an object-prototype name is an action like any other, in either file', (t) => {
  const json = '{"scripts":{"run":{"__proto__":{"command":"x"},"constructor":{"command":"c"},"ok":{"command":"a"}}}}';
  assert.deepEqual(
    resolveEnvironment(repoWith(t, { [JSON_FILE]: json })).actions.map((a: any) => [a.name, a.command]),
    [
      ['__proto__', 'x'],
      ['constructor', 'c'],
      ['ok', 'a'],
    ],
  );
  const layered = resolveEnvironment(
    repoWith(t, {
      [SHARED]: '[scripts.run.constructor]\ncommand = "shared"\n[scripts.run.toString]\ncommand = "s"\n',
      [LOCAL]: '[scripts.run.constructor]\nargs = ["--mine"]\n[scripts.run.valueOf]\ncommand = "v"\n',
    }),
  );
  assert.deepEqual(
    layered.actions.map((a: any) => [a.name, a.command]),
    [
      ['constructor', 'shared --mine'],
      ['toString', 's'],
      ['valueOf', 'v'],
    ],
  );
  assert.deepEqual(layered.unreadable, []);
});

test('a read failure with no message is still a failure with a reason, never an absent or empty config', (t) => {
  const repo = repoWith(t, { [ENV]: '[setup]\nscript = "own"\n' });
  for (const [thrown, reason] of [
    [new Error(''), 'Error'],
    ['', 'unreadable'],
  ] as const) {
    const reader = t.mock.method(fs, 'readFileSync', () => {
      throw thrown;
    });
    try {
      const r = resolveEnvironment(repo);
      assert.deepEqual([r.source, r.error, r.setup], ['environment', reason, '']);
      assert.throws(() => setupScriptOf(repo, 'darwin', () => {}), new RegExp(`^Error: ${reason}$`));
    } finally {
      reader.mock.restore();
    }
  }
});

test('env:resolve and env:convert answer for an absolute project root only', (t) => {
  const handlers: Record<string, (...a: any[]) => any> = {};
  register({ handle: (channel: string, fn: any) => (handlers[channel] = fn) });
  assert.deepEqual(Object.keys(handlers).sort(), ['env:convert', 'env:resolve']);
  const repo = repoWith(t, { [SHARED]: '[scripts]\nsetup = "pnpm install"\n' });
  assert.deepEqual(handlers['env:resolve'](null, repo), resolveEnvironment(repo));
  for (const bad of ['relative/path', '', null, 7]) {
    assert.throws(() => handlers['env:resolve'](null, bad), /invalid/);
    assert.deepEqual(handlers['env:convert'](null, bad), {
      ok: false,
      error: 'invalid',
    });
  }
  assert.deepEqual(handlers['env:convert'](null, repo), {
    ok: true,
    file: path.join(repo, ENV),
  });
  assert.equal(handlers['env:resolve'](null, repo).source, 'environment');
});
