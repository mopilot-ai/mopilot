// bench/lib/contractNightly.mjs: where the nightly looks for new harness versions, which it runs, the versions.tested
// edit a passing run proposes, and the pull request and harness-regression issue texts (no network, no VM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const n = await import('../bench/lib/contractNightly.mjs');
const require = createRequire(import.meta.url);
const { compareVersions } = require('../electron/harness/versions.cjs');
const ROOT = path.join(import.meta.dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('sources: npm for every harness, brew and the vendor feed where they exist', () => {
  assert.deepEqual(
    n.SOURCES.codex.map((s: any) => s.type),
    ['npm', 'brew'],
  );
  assert.deepEqual(
    n.SOURCES.claude.map((s: any) => s.type),
    ['npm', 'brew', 'feed', 'feed'],
  );
  assert.deepEqual(n.SOURCES['acp:dsh'], [{ type: 'npm', tags: ['latest'] }]);
});

test('candidates: every source read, a missing tag or a failing source reported while the others still count', async () => {
  const urls: string[] = [];
  const net = {
    getJson: async (url: string) => {
      urls.push(url);
      if (url.includes('registry.npmjs.org')) return { latest: '2.1.302', stable: 'v2.1.292', next: '2.1.302' };
      if (url.includes('claude-code.json')) return { version: '2.1.292' };
      throw new Error(`unexpected ${url}`);
    },
    getText: async (url: string) => {
      urls.push(url);
      if (url.endsWith('/latest')) return '2.1.302\n';
      throw new Error('HTTP 503');
    },
  };
  const r = await n.fetchCandidates('claude', net);
  assert.deepEqual(r.found, [
    { source: 'npm @anthropic-ai/claude-code@latest', version: '2.1.302' },
    { source: 'npm @anthropic-ai/claude-code@stable', version: '2.1.292' },
    { source: 'brew claude-code', version: '2.1.292' },
    { source: 'claude.ai latest', version: '2.1.302' },
  ]);
  assert.deepEqual(r.errors, ['claude.ai stable: HTTP 503']);
  assert.ok(urls.includes('https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags'));
  assert.ok(urls.includes('https://formulae.brew.sh/api/cask/claude-code.json'));

  const odd = await n.fetchCandidates('codex', {
    getJson: async (url: string) => (url.includes('npmjs') ? {} : { version: '0.163.0,abc123' }),
    getText: async () => '',
  });
  assert.deepEqual(odd.found, []);
  assert.deepEqual(odd.errors, [
    'npm @openai/codex@latest: no release version (null)',
    'brew codex: no release version ("0.163.0,abc123")',
  ]);
  const down = await n.fetchCandidates('acp:dsh', {
    getJson: async () => {
      throw 'offline';
    },
    getText: async () => '',
  });
  assert.deepEqual(down, { found: [], errors: ['npm @deepseek-ai/dsh: offline'] });
  assert.deepEqual(await n.fetchCandidates('nope', { getJson: async () => ({}), getText: async () => '' }), { found: [], errors: [] });
});

test('committed versions are read the way the contract run reads them', async () => {
  const c = await import('../bench/lib/contract.mjs');
  assert.equal(n.committedVersions, c.committedVersions);
});

test('unseen versions: not tested, known bad, below min, committed or settled; incomplete ones until the attempt limit', () => {
  const committed = { min: '2.1.295', knownBad: ['2.1.299'], tested: ['2.1.295'] };
  const found = ['2.1.302', '2.1.292', '2.1.295', '2.1.299', '2.1.300', '2.1.301', '2.1.303', '2.1.304', '2.1.302'].map((version) => ({
    version,
  }));
  const state = {
    'claude@2.1.300': { verdict: 'fail', attempts: 1 },
    'claude@2.1.303': { verdict: 'incomplete', attempts: 3 },
    'claude@2.1.304': { verdict: 'incomplete', attempts: 1 },
    'claude@2.1.305': { verdict: 'pass', attempts: 1 },
  };
  assert.deepEqual(n.unseenVersions(found, committed, ['2.1.301'], state, 'claude', compareVersions, 3), ['2.1.302', '2.1.304']);
  assert.deepEqual(n.unseenVersions([{ version: '2.1.305' }], committed, [], state, 'claude', compareVersions, 3), []);
});

test('the versions.tested edit: one list, in version order, both committed copies, and a loud failure when the entry moved', () => {
  for (const v of n.VERSION_FILES) {
    const text = read(v.file);
    for (const kind of ['codex', 'claude']) {
      const edited = n.addTested(text, v.anchor(kind), '9.9.9', compareVersions);
      assert.notEqual(edited, text, `${v.file} ${kind}`);
      const added = edited.split('\n').filter((l, i) => l !== text.split('\n')[i]);
      assert.equal(added.length, 1, 'one line changes');
      assert.match(added[0], /tested: \[.*'9\.9\.9'\]/);
      assert.equal(n.addTested(edited, v.anchor(kind), '9.9.9', compareVersions), edited, 'adding it twice changes nothing');
    }
  }
  const text = "x\n  codex: { min: '1', knownBad: [], tested: ['0.2.0', '0.10.0'] },\n  claude: { tested: [] }";
  assert.equal(
    n.addTested(text, '\n  codex: { min:', '0.9.0-alpha.1', compareVersions),
    "x\n  codex: { min: '1', knownBad: [], tested: ['0.2.0', '0.9.0-alpha.1', '0.10.0'] },\n  claude: { tested: [] }",
  );
  assert.throws(() => n.addTested(text, '\n  gemini: {', '1.0.0', compareVersions), /no "gemini: \{" entry/);
  assert.throws(() => n.addTested('\n  codex: { min:', '\n  codex: { min:', '1.0.0', compareVersions), /no tested list after/);
});

const record = (o: object = {}) => ({
  kind: 'codex',
  label: 'Codex',
  version: '0.163.0',
  verdict: 'fail',
  seconds: 3600,
  install: { package: '@openai/codex@0.163.0', seconds: 400 },
  environment: { app: '0.3.0', commit: 'abcdef1234567890', macos: '26.0', vm: 'mopilot-bench', codex: '0.162.1', claude: '2.1.296' },
  baseline: { version: '0.162.1', file: 'codex@0.162.1.json' },
  suites: {
    conformance: { verdict: 'fail', seconds: 900, counts: { pass: 16, fail: 1 } },
    edge: { verdict: 'error', why: 'ungradable runs' },
  },
  items: [
    {
      key: 'edge:codex:hang',
      suite: 'edge',
      verdict: 'FAIL',
      failing: true,
      edge: 'E-P5c',
      rows: ['CM-L16'],
      attempts: ['FAIL', 'FAIL'],
      why: ['the turn did not end in time'],
    },
    { key: 'edge:switch:pdf', suite: 'edge', verdict: 'FAIL', failing: true, rows: [] },
    {
      key: 'conformance:X4',
      suite: 'conformance',
      verdict: 'fail',
      failing: true,
      rows: [],
      semantics: ['review'],
      why: ['wrote ~/.codex/config.toml'],
    },
    { key: 'conformance:X1', suite: 'conformance', verdict: 'pass', failing: false, rows: [] },
  ],
  regressions: ['edge:codex:hang', 'edge:switch:pdf', 'edge:gone'],
  known: ['conformance:X4'],
  failingRows: ['CM-L16'],
  ...o,
});

test('the issue: one title per harness version, failing rows first, regressions, conformance, known, and rows still missing', () => {
  const { title, body } = n.issueText(record());
  assert.equal(title, 'Harness regression: Codex 0.163.0 fails the version contract');
  assert.match(body, /\*\*Failing CM rows:\*\* CM-L16/);
  assert.match(body, /- `edge:codex:hang` FAIL \(attempts: FAIL → FAIL\), E-P5c, rows CM-L16: the turn did not end in time/);
  assert.match(
    body,
    /### Conformance checks that fail \(also on the baseline\)\n\n- `conformance:X4` fail, semantics review: wrote ~\/\.codex\/config\.toml/,
  );
  assert.match(body, /### Known failures \(the baseline failed them too\)\n\n- `conformance:X4`/);
  assert.match(body, /### Failures without a CM row[\s\S]*- `edge:switch:pdf`/);
  assert.match(body, /\| conformance \| fail \| 900 s \| \{"pass":16,"fail":1\} \|/);
  assert.match(body, /\| edge \| error \| - s \| ungradable runs \|/);
  assert.match(
    body,
    /MoPilot 0\.3\.0 at `abcdef123456`, macOS 26\.0 \(mopilot-bench\), install @openai\/codex@0\.163\.0 in 400 s, whole run 60 min\. Other harness: Codex 0\.162\.1, Claude Code 2\.1\.296\./,
  );
  assert.match(body, /node bench\/contract-run\.mjs --harness codex --version 0\.163\.0/);
  const bare = n.issueText({ kind: 'acp:dsh', label: 'dsh', version: '1.0.0' }).body;
  assert.match(bare, /\*\*Failing CM rows:\*\* none named/);
  assert.match(bare, /on the baseline \(none\)\)\n\nNone\./);
  assert.match(bare, /MoPilot \? at `\?`, macOS \? \(VM\), install undefined in \? s, whole run 0 min/);
  assert.doesNotMatch(bare, /Known failures|Conformance checks that fail|without a CM row/);
  const mid = n.issueText(record({ suites: { x: { verdict: 'pass', seconds: 1 } } })).body;
  assert.match(mid, /\| x \| pass \| 1 s \|  \|/);
});

test('the pull request: branch per version, the found sources, the baseline and known failures', () => {
  const pr = n.prText(record({ verdict: 'pass', regressions: [], known: ['edge:switch:pdf'] }), 'npm @openai/codex@latest, brew codex');
  assert.equal(pr.branch, 'harness-contract/codex@0.163.0');
  assert.equal(pr.title, 'Add Codex 0.163.0 to versions.tested (harness version contract)');
  assert.match(pr.body, /found Codex 0\.163\.0 \(npm @openai\/codex@latest, brew codex\)/);
  assert.match(pr.body, /Baseline: 0\.162\.1 \(`codex@0\.162\.1\.json`\)\. Known failures carried from it: `edge:switch:pdf`\./);
  const first = n.prText(record({ verdict: 'pass', baseline: null, known: [] }), 'npm');
  assert.match(first.body, /Baseline: none\. Known failures carried from it: none\./);
  assert.equal(n.prText({ kind: 'acp:dsh', label: 'dsh', version: '1.0.0' }, 'npm').branch, 'harness-contract/acp-dsh@1.0.0');
});

test('home folders leave the committed contract as ~, and only the folder itself', () => {
  assert.deepEqual(n.withoutHome({ a: '/Users/admin2/y', b: '/Users/admin', c: '/Users/a.b/z', d: '/Users/aXb/z' }, '/Users/admin'), {
    a: '/Users/admin2/y',
    b: '~',
    c: '/Users/a.b/z',
    d: '/Users/aXb/z',
  });
  assert.deepEqual(
    n.withoutHome({ c: '/Users/a.b/z', d: '/Users/aXb/z' }, '/Users/a.b'),
    { c: '~/z', d: '/Users/aXb/z' },
    'a dot is a dot',
  );
  assert.deepEqual(n.withoutHome({ file: '/Users/admin/contract/x.json', why: ['/Users/admin/a and /Users/admin/b'] }, '/Users/admin'), {
    file: '~/contract/x.json',
    why: ['~/a and ~/b'],
  });
});
