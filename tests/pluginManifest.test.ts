// Plugin and marketplace manifests in both vendor layouts, and what reaches each harness family
// (shared/plugins/manifest.mjs, marketplace.mjs, reach.mjs). Data is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPluginName,
  pluginId,
  parsePluginId,
  pluginRelative,
  readManifest,
  frontMatter,
  markdownComponent,
  expandRoot,
  normalizeMcpServers,
  normalizeHooks,
  normalizeApps,
  whatRuns,
} from '../shared/plugins/manifest.mjs';
import { isFetchableUrl, entrySource, readMarketplace, parseMarketplaceSource } from '../shared/plugins/marketplace.mjs';
import { componentsOf, componentReach, pluginReach, REACH_WHY } from '../shared/plugins/reach.mjs';

test('plugin ids are <name>@<marketplace> with names both vendors accept', () => {
  assert.equal(isPluginName('stripe'), true);
  assert.equal(isPluginName('a.b_c-1'), true);
  assert.equal(isPluginName('-x'), false);
  assert.equal(isPluginName('has space'), false);
  assert.equal(isPluginName(3), false);
  assert.equal(pluginId('stripe', 'official'), 'stripe@official');
  assert.deepEqual(parsePluginId('stripe@official'), { name: 'stripe', marketplace: 'official' });
  assert.equal(parsePluginId('stripe'), null);
  assert.equal(parsePluginId('@official'), null);
  assert.equal(parsePluginId('bad name@official'), null);
  assert.equal(parsePluginId('stripe@bad mkt'), null);
  assert.equal(parsePluginId(null), null);
});

test('component paths stay inside the plugin', () => {
  assert.equal(pluginRelative('./skills/'), 'skills');
  assert.equal(pluginRelative('a\\b'), 'a/b');
  assert.equal(pluginRelative('/etc'), null);
  assert.equal(pluginRelative('C:\\x'), null);
  assert.equal(pluginRelative('a/../b'), null);
  assert.equal(pluginRelative('./'), null);
  assert.equal(pluginRelative(5), null);
});

test('a Claude manifest: defaults, custom folders, inline hooks and an author object', () => {
  const r = readManifest(
    JSON.stringify({
      name: 'stripe',
      version: '0.10.3',
      description: 'Stripe tools',
      author: { name: 'Stripe' },
      homepage: 'https://stripe.com',
      category: 'payments',
      commands: ['./cmds', '../escape'],
      agents: './team',
      hooks: { PostToolUse: [] },
      mcpServers: './servers.json',
      apps: '/abs/apps.json',
    }),
    '.claude-plugin/plugin.json',
  );
  assert.ok(r.ok);
  const m = r.manifest;
  assert.equal(m.displayName, 'stripe');
  assert.equal(m.author, 'Stripe');
  assert.equal(m.category, 'payments');
  assert.deepEqual(m.skills, ['skills']);
  assert.deepEqual(m.commands, ['cmds']);
  assert.deepEqual(m.agents, ['team']);
  assert.deepEqual(m.hooks, { entries: [{ inline: { PostToolUse: [] } }], optional: false });
  assert.deepEqual(m.mcpServers, { entries: [{ file: 'servers.json' }], optional: false });
  assert.deepEqual(m.apps, { entries: [], optional: false });
  assert.deepEqual(m.problems, [
    'commands: "../escape" is not a path inside the plugin',
    'apps: "/abs/apps.json" is not a path inside the plugin',
  ]);
});

test('hooks and MCP servers may be listed as several files and inline objects, and each is kept', () => {
  const r = readManifest(
    JSON.stringify({ name: 'p', hooks: ['./a.json', { Stop: [] }, '../x.json'], mcpServers: ['./one.json', './two.json'] }),
    'x',
  );
  assert.ok(r.ok);
  assert.deepEqual(r.manifest.hooks, { entries: [{ file: 'a.json' }, { inline: { Stop: [] } }], optional: false });
  assert.deepEqual(r.manifest.mcpServers, { entries: [{ file: 'one.json' }, { file: 'two.json' }], optional: false });
  assert.deepEqual(r.manifest.problems, ['hooks: "../x.json" is not a path inside the plugin']);
});

test('a Codex manifest takes its display fields from interface', () => {
  const r = readManifest(
    JSON.stringify({
      name: 'gmail',
      apps: './.app.json',
      interface: {
        displayName: 'Gmail',
        shortDescription: 'Mail',
        category: 'Communication',
        developerName: 'OpenAI',
        logo: './assets/logo.png',
      },
    }),
    '.codex-plugin/plugin.json',
  );
  assert.ok(r.ok);
  assert.equal(r.manifest.displayName, 'Gmail');
  assert.equal(r.manifest.description, 'Mail');
  assert.equal(r.manifest.category, 'Communication');
  assert.equal(r.manifest.author, 'OpenAI');
  assert.equal(r.manifest.logo, 'assets/logo.png');
  assert.deepEqual(r.manifest.apps, { entries: [{ file: '.app.json' }], optional: false });
  assert.deepEqual(r.manifest.hooks, { entries: [{ file: 'hooks/hooks.json' }], optional: true });
  const plain = readManifest(JSON.stringify({ name: 'p', author: 'Someone', interface: { logo: '/abs.png' } }), 'x');
  assert.ok(plain.ok);
  assert.equal(plain.manifest.author, 'Someone');
  assert.equal(plain.manifest.logo, undefined);
});

test('unusable manifests say why', () => {
  assert.deepEqual(readManifest('{', 'x'), { ok: false, error: 'plugin.json is not valid JSON' });
  assert.deepEqual(readManifest('[]', 'x'), { ok: false, error: 'plugin.json is not a JSON object' });
  assert.deepEqual(readManifest('{"name":"a b"}', 'x'), { ok: false, error: 'plugin.json has no usable name' });
});

test('front matter: plain, quoted and block values; no front matter is nothing', () => {
  assert.deepEqual(frontMatter('just text'), {});
  assert.deepEqual(
    frontMatter('\uFEFF---\nname: "tidy"\ndescription: >\n  first line\n  second\nother: \'x\'\n  stray continuation\n...\nbody'),
    { name: 'tidy', description: 'first line second', other: 'x' },
  );
  assert.deepEqual(frontMatter('---\nnote: |\n---\n'), { note: '' });
  assert.deepEqual(markdownComponent('---\nname: n\ndescription: d\n---\n', 'fallback', '/f'), { name: 'n', description: 'd', file: '/f' });
  assert.deepEqual(markdownComponent('no fm', 'fallback', '/f'), { name: 'fallback', description: undefined, file: '/f' });
});

test('plugin root placeholders expand in strings only', () => {
  assert.equal(expandRoot('${CLAUDE_PLUGIN_ROOT}/a ${PLUGIN_ROOT}/b', '/r'), '/r/a /r/b');
  assert.equal(expandRoot(7, '/r'), 7);
});

test('MCP servers: stdio and remote, from a file or inline, with bad ones reported', () => {
  const file = normalizeMcpServers(
    {
      mcpServers: {
        local: {
          command: '${CLAUDE_PLUGIN_ROOT}/bin',
          args: ['--root', '${CLAUDE_PLUGIN_ROOT}', 3],
          env: { A: '${CLAUDE_PLUGIN_ROOT}', B: 1 },
        },
        typed: { type: 'stdio', command: 'x' },
        remote: { type: 'http', url: 'https://mcp.example', headers: { Authorization: 'k', n: 2 } },
        stream: { type: 'sse', url: 'https://sse.example' },
        bare: { url: 'https://bare.example' },
        wrongType: { type: 'http', command: 'x' },
        broken: 'nope',
      },
    },
    '/root',
  );
  assert.deepEqual(file.servers.local, { type: 'stdio', command: '/root/bin', args: ['--root', '/root'], env: { A: '/root' } });
  assert.deepEqual(file.servers.typed, { type: 'stdio', command: 'x', args: [], env: {} });
  assert.deepEqual(file.servers.remote, { type: 'http', url: 'https://mcp.example', headers: { Authorization: 'k' } });
  assert.deepEqual(file.servers.stream, { type: 'sse', url: 'https://sse.example', headers: {} });
  assert.equal(file.servers.bare.type, 'http');
  // a shape MoPilot can't pass on is kept (a harness loading the folder may start it), and reported
  assert.deepEqual(file.servers.wrongType, { type: 'other', raw: '{"type":"http","command":"x"}' });
  assert.deepEqual(file.problems, [
    'MCP server "wrongType" isn\'t a local command or an http/sse URL',
    'MCP server "broken" is not an object',
  ]);
  assert.deepEqual(Object.keys(normalizeMcpServers({ s: { command: 'c' } }, '/r').servers), ['s']);
  assert.deepEqual(normalizeMcpServers(null, '/r'), { servers: {}, problems: [] });
});

test('hook commands are listed per event, from a file or inline', () => {
  const hooks = {
    hooks: {
      PostToolUse: [
        { matcher: 'Edit', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/fmt' }, { type: 'prompt' }, 'x'] },
        'junk',
        { hooks: 'x' },
      ],
      SessionStart: [{ hooks: [{ command: 'hello' }] }],
      Bad: 'not a list',
    },
  };
  assert.deepEqual(normalizeHooks(hooks, '/r'), [
    { event: 'PostToolUse', matcher: 'Edit', command: '/r/fmt' },
    { event: 'SessionStart', matcher: undefined, command: 'hello' },
  ]);
  assert.equal(normalizeHooks({ Stop: [{ hooks: [{ command: 'c' }] }] }, '/r').length, 1);
  assert.deepEqual(normalizeHooks(null, '/r'), []);
});

test('app connectors and what a plugin runs', () => {
  assert.deepEqual(normalizeApps({ apps: { b: {}, a: {} } }), ['a', 'b']);
  assert.deepEqual(normalizeApps(null), []);
  assert.deepEqual(
    whatRuns({
      mcpServers: { s: { type: 'stdio', command: 'node', args: ['srv.js'], env: {} }, r: { type: 'http', url: 'https://x', headers: {} } },
      hooks: [
        { event: 'Stop', command: 'a' },
        { event: 'PostToolUse', matcher: 'Edit', command: 'b' },
      ],
    }),
    ['hook PostToolUse (Edit): b', 'hook Stop: a', 'mcp r: http https://x', 'mcp s: node srv.js'],
  );
  assert.deepEqual(whatRuns({} as never), []);
  assert.deepEqual(whatRuns({ mcpServers: { w: { type: 'other', raw: '{"type":"ws"}' } }, hooks: [] }), ['mcp w: {"type":"ws"}']);
  // the plugin's own folder is written as the placeholder, so moving it doesn't change what it runs
  assert.deepEqual(
    whatRuns({ root: '/a/p', mcpServers: { s: { type: 'stdio', command: '/a/p/bin', args: ['/a/p/x'], env: {} } }, hooks: [] }),
    ['mcp s: ${PLUGIN_ROOT}/bin ${PLUGIN_ROOT}/x'],
  );
});

test('marketplace sources: only https and ssh git, and safe refs', () => {
  assert.equal(isFetchableUrl('https://github.com/a/b.git'), true);
  assert.equal(isFetchableUrl('git@github.com:a/b.git'), true);
  assert.equal(isFetchableUrl('ssh://git@host/a'), true);
  assert.equal(isFetchableUrl('file:///etc'), false);
  assert.equal(isFetchableUrl('ext::sh -c x'), false);
  assert.equal(isFetchableUrl(1), false);
  assert.deepEqual(entrySource('./plugins/a'), { kind: 'path', path: 'plugins/a' });
  assert.equal(entrySource('../a'), null);
  assert.equal(entrySource(4), null);
  assert.deepEqual(entrySource({ source: 'local', path: './a/1.0' }), { kind: 'path', path: 'a/1.0' });
  assert.equal(entrySource({ source: 'local', path: '/abs' }), null);
  assert.deepEqual(entrySource({ source: 'github', repo: 'o/r' }), {
    kind: 'git',
    url: 'https://github.com/o/r.git',
    ref: undefined,
    sha: undefined,
    path: undefined,
  });
  assert.equal(entrySource({ source: 'github', repo: 'no-slash' }), null);
  assert.deepEqual(entrySource({ source: 'url', url: 'https://x/y.git', sha: 'abc123', ref: '-bad' }), {
    kind: 'git',
    url: 'https://x/y.git',
    ref: undefined,
    sha: 'abc123',
    path: undefined,
  });
  assert.deepEqual(entrySource({ source: 'git-subdir', url: 'https://x/y.git', path: 'plugins/p', ref: 'v1.2' }), {
    kind: 'git',
    url: 'https://x/y.git',
    ref: 'v1.2',
    sha: undefined,
    path: 'plugins/p',
  });
  assert.equal(entrySource({ source: 'git-subdir', url: 'https://x/y.git', path: '../up' }), null);
  assert.equal((entrySource({ source: 'url', url: 'https://x/y.git', ref: 'a..b' }) as { ref?: string }).ref, undefined);
  assert.equal(entrySource({ source: 'npm', package: 'x' }), null);
});

test('marketplace manifests in either layout, with unusable entries reported', () => {
  assert.deepEqual(readMarketplace('{'), { ok: false, error: 'marketplace.json is not valid JSON' });
  assert.deepEqual(readMarketplace('{"name":"a b"}'), { ok: false, error: 'marketplace.json has no usable name' });
  assert.deepEqual(readMarketplace('[]'), { ok: false, error: 'marketplace.json has no usable name' });
  const r = readMarketplace(
    JSON.stringify({
      name: 'mkt',
      description: 'Things',
      plugins: [
        { name: 'a', source: './a', description: 'A', category: 'dev', version: '1', author: { name: 'Ann' } },
        { name: 'b', source: { source: 'local', path: './b' }, author: 'Bo', interface: { shortDescription: 'B', category: 'ops' } },
        { name: 'bad name', source: './c' },
        { name: 'nosrc' },
        'junk',
      ],
    }),
  );
  assert.ok(r.ok);
  assert.equal(r.marketplace.description, 'Things');
  assert.deepEqual(r.marketplace.plugins[0], {
    name: 'a',
    description: 'A',
    category: 'dev',
    version: '1',
    author: 'Ann',
    source: { kind: 'path', path: 'a' },
  });
  assert.deepEqual(r.marketplace.plugins[1], {
    name: 'b',
    description: 'B',
    category: 'ops',
    version: undefined,
    author: 'Bo',
    source: { kind: 'path', path: 'b' },
  });
  assert.deepEqual(r.marketplace.problems, [
    'Entry "bad name" has no usable name or source',
    'Entry "nosrc" has no usable name or source',
    'Entry "?" has no usable name or source',
  ]);
  const empty = readMarketplace('{"name":"m"}');
  assert.ok(empty.ok);
  assert.deepEqual(empty.marketplace.plugins, []);
});

test('what the user types to add a marketplace', () => {
  assert.deepEqual(parseMarketplaceSource(' /Users/me/mkt ', '/h'), { kind: 'local', path: '/Users/me/mkt' });
  assert.deepEqual(parseMarketplaceSource('~/mkt', '/h'), { kind: 'local', path: '/h/mkt' });
  assert.deepEqual(parseMarketplaceSource('owner/repo', '/h'), { kind: 'git', url: 'https://github.com/owner/repo.git', ref: undefined });
  assert.deepEqual(parseMarketplaceSource('https://x/y.git#v2', '/h'), { kind: 'git', url: 'https://x/y.git', ref: 'v2' });
  assert.deepEqual(parseMarketplaceSource('owner/repo#', '/h'), { kind: 'git', url: 'https://github.com/owner/repo.git', ref: undefined });
  assert.equal(parseMarketplaceSource('owner/repo#-x', '/h'), null);
  // a Windows folder: a drive or a share, and ~\ for home; only on Windows, where nothing else reads them as a folder
  const home = 'C:\\Users\\me';
  assert.deepEqual(parseMarketplaceSource('C:\\Users\\me\\mkt', home, 'win32'), { kind: 'local', path: 'C:\\Users\\me\\mkt' });
  assert.deepEqual(parseMarketplaceSource('d:/mkt', home, 'win32'), { kind: 'local', path: 'd:/mkt' });
  assert.deepEqual(parseMarketplaceSource('\\\\nas\\share\\mkt', home, 'win32'), { kind: 'local', path: '\\\\nas\\share\\mkt' });
  assert.deepEqual(parseMarketplaceSource('~\\mkt', home, 'win32'), { kind: 'local', path: 'C:\\Users\\me\\mkt' });
  assert.deepEqual(parseMarketplaceSource('owner/repo', home, 'win32'), {
    kind: 'git',
    url: 'https://github.com/owner/repo.git',
    ref: undefined,
  });
  assert.equal(parseMarketplaceSource('C:\\Users\\me\\mkt', '/h', 'darwin'), null);
  assert.equal(parseMarketplaceSource('C:', home, 'win32'), null);
  assert.equal(parseMarketplaceSource('file:///x', '/h'), null);
  assert.equal(parseMarketplaceSource(undefined, '/h'), null);
});

const spec = {
  skills: [{ name: 'tidy', file: '/s' }],
  commands: [{ name: 'go', file: '/c' }],
  agents: [{ name: 'helper', file: '/a' }],
  hooks: [{ event: 'Stop', command: 'x' }],
  mcpServers: {
    local: { type: 'stdio' as const, command: 'c', args: [], env: {} },
    remote: { type: 'http' as const, url: 'https://x', headers: {} },
  },
  apps: ['gmail'],
};

test('every component kind is listed once', () => {
  assert.deepEqual(componentsOf(spec), [
    { kind: 'skills', name: 'tidy' },
    { kind: 'commands', name: 'go' },
    { kind: 'agents', name: 'helper' },
    { kind: 'hooks', name: 'Stop' },
    { kind: 'mcpServers', name: 'local', transport: 'stdio' },
    { kind: 'mcpServers', name: 'remote', transport: 'http' },
    { kind: 'apps', name: 'gmail' },
  ]);
  assert.deepEqual(componentsOf({} as never), []);
});

test('reach per family: native, MoPilot-provided or unavailable with a why', () => {
  const by = (family: string, mcp?: { stdio: boolean; http: boolean }) =>
    Object.fromEntries(pluginReach(spec, family, mcp).components.map((c) => [`${c.kind}:${c.name}`, c.why ?? c.reach]));
  assert.deepEqual(by('claude'), {
    'skills:tidy': 'native',
    'commands:go': 'native',
    'agents:helper': 'native',
    'hooks:Stop': 'native',
    'mcpServers:local': 'native',
    'mcpServers:remote': 'native',
    'apps:gmail': 'plugin.appsCodexOnly',
  });
  assert.equal(by('codex')['apps:gmail'], 'native');
  assert.equal(by('codex')['agents:helper'], 'native');
  assert.deepEqual(by('acp'), {
    'skills:tidy': 'mopilot',
    'commands:go': 'mopilot',
    'agents:helper': 'mopilot',
    'hooks:Stop': 'plugin.hooksNotOnBasic',
    'mcpServers:local': 'native',
    'mcpServers:remote': 'plugin.mcpHttpUnsupported',
    'apps:gmail': 'plugin.appsCodexOnly',
  });
  assert.equal(by('acp', { stdio: false, http: true })['mcpServers:local'], 'plugin.mcpStdioUnsupported');
  assert.equal(by('acp', { stdio: false, http: true })['mcpServers:remote'], 'native');
  const other = { ...componentsFree(), mcpServers: { w: { type: 'other' as const, raw: '{}' } } };
  assert.deepEqual(pluginReach(other, 'acp', { stdio: true, http: true }).components[0].why, 'plugin.mcpTransportUnknown');
  assert.equal(pluginReach(other, 'claude').components[0].reach, 'native');
  assert.deepEqual(componentReach({ kind: 'skills', name: 'x' }, 'other'), { reach: 'unavailable', why: 'plugin.familyUnknown' });
  for (const c of pluginReach(spec, 'acp').components) if (c.why) assert.ok(REACH_WHY[c.why], c.why);
});

test('the badge summary: full, partial or none', () => {
  assert.equal(pluginReach(spec, 'claude').summary, 'partial');
  assert.equal(pluginReach({ ...spec, apps: [] }, 'claude').summary, 'full');
  assert.equal(pluginReach({ ...componentsFree(), apps: ['gmail'] }, 'claude').summary, 'none');
  assert.equal(pluginReach(componentsFree(), 'acp').summary, 'full');
});

function componentsFree() {
  return { skills: [], commands: [], agents: [], hooks: [], mcpServers: {}, apps: [] as string[] };
}
