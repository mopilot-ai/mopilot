// electron/harness/installMethod.cjs: how a harness CLI was installed, from where its binary really is, and the
// command that updates it the same way, or why there is none (magpie's howInstalled order).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { howInstalled, installSource, hostIo, published, realIo } = require('../electron/harness/installMethod.cjs');

/** links: bin -> real path; files that exist; folders that can be written; tools on PATH. */
const io = (
  o: { links?: Record<string, string>; files?: string[]; writable?: string[]; tools?: Record<string, string>; platform?: string } = {},
) => ({
  realpath: (p: string) => {
    if (p === '/broken') throw new Error('ENOENT');
    return o.links?.[p] ?? p;
  },
  exists: (p: string) => (o.files ?? []).includes(p),
  canWrite: (p: string) => (o.writable ?? []).includes(p),
  which: (n: string) => o.tools?.[n] ?? null,
  platform: o.platform ?? 'darwin',
  home: '/Users/ada',
  pathEnv: '/usr/bin:/bin',
});
const pick = (m: any) => ({ via: m.via, shown: m.shown, blocked: m.blocked, from: m.from, pkg: m.pkg });

test("a CLI's own updater, found by where its vendor's installer puts it, is read from the npm package's newest", () => {
  const claude = howInstalled(
    'claude',
    '/Users/ada/.local/bin/claude',
    io({ links: { '/Users/ada/.local/bin/claude': '/Users/ada/.local/share/claude/versions/2.1.296' } }),
  );
  assert.deepEqual(pick(claude), {
    via: 'self',
    shown: 'claude update',
    blocked: null,
    from: 'standalone install',
    pkg: '@anthropic-ai/claude-code',
  });
  assert.deepEqual(claude.argv, ['/Users/ada/.local/bin/claude', 'update']);
  assert.equal(howInstalled('claude', 'C:\\Users\\ada\\.local\\bin\\claude.exe', io({ platform: 'win32' })).via, 'self');
  const codex = howInstalled(
    'codex',
    '/x/codex',
    io({ links: { '/x/codex': '/Users/ada/.codex/packages/standalone/releases/0.163/codex' } }),
  );
  assert.equal(codex.shown, 'codex update');
  assert.equal(howInstalled('acp:opencode', '/Users/ada/.opencode/bin/opencode', io()).shown, 'opencode upgrade');
  assert.equal(
    howInstalled(
      'acp:cursor',
      '/b/cursor-agent',
      io({ links: { '/b/cursor-agent': '/Users/ada/.local/share/cursor-agent/versions/2026.10/cursor-agent' } }),
    ).shown,
    'cursor-agent update',
  );
  // Cursor has no npm package: its own updater, and no newest version to read
  assert.equal(howInstalled('acp:cursor', '/Users/ada/.local/share/cursor-agent/versions/1/cursor-agent', io()).pkg, null);
  assert.equal(howInstalled('acp:goose', '/Users/ada/.local/bin/goose', io()).shown, 'goose update');
});

test("a desktop app's bundled CLI updates with the app; a link that leads nowhere is read as found", () => {
  const m = howInstalled('codex', '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex', io());
  assert.deepEqual(pick(m), { via: 'app-bundle', shown: null, blocked: 'app-bundle', from: 'ChatGPT.app', pkg: null });
  assert.deepEqual(pick(howInstalled('codex', '/broken', io())), {
    via: 'unknown',
    shown: null,
    blocked: 'unknown-install',
    from: '',
    pkg: null,
  });
});

test("Homebrew's own formula or cask, by the brew of its prefix, even for a Node CLI inside its keg", () => {
  const cask = howInstalled(
    'claude',
    '/opt/homebrew/bin/claude',
    io({
      links: { '/opt/homebrew/bin/claude': '/opt/homebrew/Caskroom/claude-code/2.1.296/claude' },
      files: ['/opt/homebrew/bin/brew'],
    }),
  );
  assert.deepEqual(pick(cask), {
    via: 'brew',
    shown: 'brew upgrade --cask claude-code',
    blocked: null,
    from: 'Homebrew cask',
    pkg: 'claude-code',
  });
  assert.equal(cask.cask, true);
  // gemini-cli's keg holds an npm package, but brew owns it
  const keg = howInstalled(
    'acp:gemini',
    '/usr/local/bin/gemini',
    io({
      links: { '/usr/local/bin/gemini': '/usr/local/Cellar/gemini-cli/0.21.0/libexec/lib/node_modules/@google/gemini-cli/dist/index.js' },
      tools: { brew: '/usr/local/bin/brew' },
    }),
  );
  assert.deepEqual(pick(keg), { via: 'brew', shown: 'brew upgrade gemini-cli', blocked: null, from: 'Homebrew', pkg: 'gemini-cli' });
  assert.equal(keg.argv[0], '/usr/local/bin/brew', 'no brew in the prefix: the one on PATH');
  // a tap's formula is under its last segment
  assert.ok(published('acp:opencode').brew.includes('opencode'));
  // no brew anywhere: nothing to run it with
  const lost = howInstalled('acp:qwen', '/q', io({ links: { '/q': '/opt/homebrew/Cellar/qwen-code/1/bin/qwen' } }));
  assert.deepEqual(pick(lost), { via: 'brew', shown: null, blocked: 'unknown-install', from: 'Homebrew', pkg: 'qwen-code' });
  // Homebrew's node keg is npm's, not a harness's own formula
  const npmUnderBrewNode = howInstalled(
    'codex',
    '/n',
    io({
      links: { '/n': '/opt/homebrew/Cellar/node/22.1.0/lib/node_modules/@openai/codex/bin/codex.js' },
      files: ['/opt/homebrew/Cellar/node/22.1.0/bin/npm'],
      writable: ['/opt/homebrew/Cellar/node/22.1.0/lib/node_modules'],
    }),
  );
  assert.equal(npmUnderBrewNode.via, 'npm');
});

test("npm: that prefix's own npm and node first on PATH, the prefix named, home as ~ in what is shown", () => {
  const prefix = '/Users/ada/.nvm/versions/node/v22.1.0';
  const m = howInstalled(
    'codex',
    `${prefix}/bin/codex`,
    io({
      links: { [`${prefix}/bin/codex`]: `${prefix}/lib/node_modules/@openai/codex/bin/codex.js` },
      files: [`${prefix}/bin/npm`],
      writable: [`${prefix}/lib/node_modules`],
    }),
  );
  assert.deepEqual(pick(m), {
    via: 'npm',
    shown: 'npm install -g --prefix ~/.nvm/versions/node/v22.1.0 @openai/codex@latest',
    blocked: null,
    from: 'npm (~/.nvm/versions/node/v22.1.0)',
    pkg: '@openai/codex',
  });
  assert.deepEqual(m.argv, [`${prefix}/bin/npm`, 'install', '-g', '--prefix', prefix, '@openai/codex@latest']);
  assert.deepEqual(m.env, { PATH: `${prefix}/bin:/usr/bin:/bin` });
  assert.equal(m.packageJson, `${prefix}/lib/node_modules/@openai/codex/package.json`);
  // the prefix has no npm of its own: the one on PATH, and PATH as it is
  const other = howInstalled(
    'codex',
    '/p/bin/codex',
    io({
      links: { '/p/bin/codex': '/p/lib/node_modules/@openai/codex/bin/codex.js' },
      writable: ['/p/lib/node_modules'],
      tools: { npm: '/usr/local/bin/npm' },
    }),
  );
  assert.equal(other.argv[0], '/usr/local/bin/npm');
  assert.equal(other.env, null);
  // nor any npm at all
  assert.equal(
    howInstalled('codex', '/p/bin/codex', io({ links: { '/p/bin/codex': '/p/lib/node_modules/@openai/codex/x' } })).blocked,
    'unknown-install',
  );
});

test('a root-owned npm folder needs admin rights: the command is shown to copy, never run with sudo', () => {
  const m = howInstalled(
    'acp:gemini',
    '/usr/local/bin/gemini',
    io({
      links: { '/usr/local/bin/gemini': '/usr/local/lib/node_modules/@google/gemini-cli/dist/index.js' },
      files: ['/usr/local/bin/npm'],
    }),
  );
  assert.equal(m.blocked, 'needs-admin');
  assert.equal(m.shown, 'npm install -g --prefix /usr/local @google/gemini-cli@latest');
  // a local node_modules (not a global lib/node_modules) is no global install of ours
  assert.equal(howInstalled('codex', '/proj/node_modules/@openai/codex/bin/codex', io()).blocked, 'unknown-install');
});

test("Windows: npm's .cmd shim beside its node_modules, and the prefix is that folder itself", () => {
  const dir = 'C:/Users/ada/AppData/Roaming/npm';
  const m = howInstalled(
    'codex',
    'C:\\Users\\ada\\AppData\\Roaming\\npm\\codex.cmd',
    io({
      platform: 'win32',
      files: [`${dir}/node_modules/@openai/codex`, `${dir}/npm.cmd`],
      writable: [`${dir}/node_modules`],
    }),
  );
  assert.deepEqual(m.argv, [`${dir}/npm.cmd`, 'install', '-g', '--prefix', dir, '@openai/codex@latest']);
  assert.deepEqual(m.env, { PATH: `${dir};/usr/bin:/bin` });
  // a .cmd that isn't npm's shim says nothing
  assert.equal(howInstalled('codex', 'C:\\tools\\codex.cmd', io({ platform: 'win32' })).blocked, 'unknown-install');
});

test('bun and pnpm update with themselves; volta, yarn, mise, asdf and nodenv are left to their manager', () => {
  const bun = howInstalled(
    'acp:opencode',
    '/b',
    io({
      links: { '/b': '/Users/ada/.bun/install/global/node_modules/opencode-ai/bin/opencode' },
      tools: { bun: '/Users/ada/.bun/bin/bun' },
    }),
  );
  assert.deepEqual(pick(bun), { via: 'bun', shown: 'bun add -g opencode-ai@latest', blocked: null, from: 'bun', pkg: 'opencode-ai' });
  const pnpm = howInstalled(
    'acp:opencode',
    '/p',
    io({ links: { '/p': '/Users/ada/Library/pnpm/global/5/node_modules/opencode-ai/bin/x' }, tools: { pnpm: '/x/pnpm' } }),
  );
  assert.equal(pnpm.shown, 'pnpm add -g opencode-ai@latest');
  assert.equal(
    howInstalled('acp:opencode', '/p2', io({ links: { '/p2': '/a/.pnpm/node_modules/opencode-ai/x' } })).blocked,
    'unknown-install',
  );
  for (const at of [
    '/Users/ada/.volta/tools/image/packages/@openai/codex/lib/node_modules/@openai/codex/x',
    '/Users/ada/.local/share/mise/installs/node/22/lib/node_modules/@openai/codex/x',
    '/Users/ada/.asdf/installs/nodejs/22/lib/node_modules/@openai/codex/x',
    '/Users/ada/.config/yarn/global/node_modules/@openai/codex/x',
    '/Users/ada/.nodenv/versions/22/lib/node_modules/@openai/codex/x',
  ])
    assert.equal(howInstalled('codex', '/c', io({ links: { '/c': at } })).blocked, 'version-manager', at);
});

test("anything else says MoPilot can't tell; the real filesystem answers for production", () => {
  assert.equal(howInstalled('acp:kimi', '/usr/local/bin/kimi', io()).blocked, 'unknown-install');
  assert.equal(howInstalled('acp:unknown', '/x', io()).blocked, 'unknown-install');
  assert.deepEqual(published('acp:nope'), { npm: [], brew: [], self: [] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-method-'));
  try {
    const file = path.join(dir, 'f');
    fs.writeFileSync(file, '');
    const real = realIo({ which: () => null, platform: 'darwin', home: '', pathEnv: '' });
    assert.equal(real.realpath(file), fs.realpathSync(file));
    assert.equal(real.exists(file), true);
    assert.equal(real.canWrite(dir), true);
    assert.equal(real.canWrite(path.join(dir, 'missing')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('what is shown quotes a folder with spaces, shows the home folder itself as ~, and leaves paths alone with no home known', () => {
  const spaced = howInstalled(
    'codex',
    '/s',
    io({
      links: { '/s': '/opt/my tools/lib/node_modules/@openai/codex/x' },
      files: ['/opt/my tools/bin/npm'],
      writable: ['/opt/my tools/lib/node_modules'],
    }),
  );
  assert.equal(spaced.shown, 'npm install -g --prefix "/opt/my tools" @openai/codex@latest');
  const home = howInstalled(
    'codex',
    '/h',
    io({
      links: { '/h': '/Users/ada/lib/node_modules/@openai/codex/x' },
      files: ['/Users/ada/bin/npm'],
      writable: ['/Users/ada/lib/node_modules'],
    }),
  );
  assert.equal(home.shown, 'npm install -g --prefix ~ @openai/codex@latest');
  const noHome = howInstalled('codex', '/h', {
    ...io({
      links: { '/h': '/Users/ada/lib/node_modules/@openai/codex/x' },
      files: ['/Users/ada/bin/npm'],
      writable: ['/Users/ada/lib/node_modules'],
    }),
    home: '',
  });
  assert.equal(noHome.shown, 'npm install -g --prefix /Users/ada @openai/codex@latest');
});

test('the version a binary is, from its version folder or its Homebrew keg, without running it', () => {
  const v = (kind: string, real: string) =>
    howInstalled(kind, '/b', io({ links: { '/b': real }, files: ['/opt/homebrew/bin/brew'] })).pathVersion;
  assert.equal(v('claude', '/Users/ada/.local/share/claude/versions/2.1.302'), '2.1.302');
  assert.equal(v('acp:cursor', '/Users/ada/.local/share/cursor-agent/versions/2026.10.01-e373342/cursor-agent'), '2026.10.01-e373342');
  assert.equal(v('codex', '/Users/ada/.codex/packages/standalone/releases/x/codex'), null);
  assert.equal(v('claude', '/opt/homebrew/Caskroom/claude-code/2.1.296,abc/claude'), '2.1.296');
  assert.equal(v('acp:qwen', '/opt/homebrew/Cellar/qwen-code/0.25.2_1/bin/qwen'), '0.25.2');
  assert.equal(v('acp:qwen', '/opt/homebrew/Cellar/qwen-code/HEAD-abc/bin/qwen'), null);
  assert.equal(
    howInstalled('acp:qwen', '/b', io({ links: { '/b': '/x/Cellar/qwen-code/0.1.0/bin/qwen' } })).pathVersion,
    '0.1.0',
    'no brew to run it: still read',
  );
});

test("Claude desktop's own copies of Claude Code update with Claude.app, on macOS and Windows", () => {
  const mac = '/Users/ada/Library/Application Support/Claude/claude-code/2.1.296/abc/claude.app/Contents/MacOS/claude';
  assert.deepEqual(pick(howInstalled('claude', mac, io())), {
    via: 'app-bundle',
    shown: null,
    blocked: 'app-bundle',
    from: 'Claude.app',
    pkg: null,
  });
  assert.equal(howInstalled('claude', mac, io()).pathVersion, null);
  const win = 'C:\\Users\\ada\\AppData\\Roaming\\Claude\\claude-code\\2.1.296\\claude.exe';
  assert.equal(howInstalled('claude', win, io({ platform: 'win32' })).from, 'Claude.app');
  // a folder of the user's own that happens to be named so is not Claude desktop's
  assert.equal(howInstalled('claude', '/Users/ada/src/Claude/claude-code/bin/claude', io()).via, 'unknown');
});

test('how each install found was made, in the two fields Settings names it by', () => {
  const links = { '/Users/ada/.local/bin/claude': '/Users/ada/.local/share/claude/versions/2.1.302' };
  assert.deepEqual(installSource('claude', '/Users/ada/.local/bin/claude', io({ links })), { via: 'self', from: 'standalone install' });
  assert.deepEqual(installSource('codex', '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex', io()), {
    via: 'app-bundle',
    from: 'ChatGPT.app',
  });
  assert.deepEqual(installSource('acp:opencode', '/somewhere/opencode', io()), { via: 'unknown', from: '' });
});

test("main's filesystem with the login shell's PATH: which and PATH come from the shell", () => {
  const io2 = hostIo({ which: (n: string) => (n === 'brew' ? '/opt/homebrew/bin/brew' : null), childEnv: () => ({ PATH: '/x:/y' }) });
  assert.equal(io2.which('brew'), '/opt/homebrew/bin/brew');
  assert.equal(io2.which('npm'), null);
  assert.equal(io2.pathEnv, '/x:/y');
  assert.equal(io2.platform, process.platform);
  assert.equal(io2.home, os.homedir());
  assert.equal(typeof io2.realpath, 'function');
});
