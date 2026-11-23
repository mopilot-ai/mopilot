// scripts/gen-matrix.mjs on synthetic inputs: every binding kind, missing results and admission states, and the command line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { recorder, runScript, tempDir } from './support/scripts-shared-cli.ts';

const gen = await import('../scripts/gen-matrix.mjs');

const versions = (tested: string[], extra = {}) => ({ min: tested[0], knownBad: [], tested, ...extra });
const REGISTRY = {
  codex: {
    kind: 'codex',
    tier: 'first',
    label: 'Codex',
    vendor: 'OpenAI',
    channel: 'npm',
    versions: versions(['1.0.0'], { knownBad: ['0.9.0'] }),
  },
  claude: { kind: 'claude', tier: 'first', label: 'Claude Code', vendor: 'Anthropic', channel: 'npm', versions: versions([]) },
  'acp:full': {
    kind: 'acp:full',
    tier: 'basic',
    label: 'Full',
    vendor: 'F',
    versions: versions(['2.0']),
    admission: { privacyGate: 'x' },
    privacyDefaults: ['TELEMETRY=0'],
  },
  'acp:none': { kind: 'acp:none', tier: 'basic', label: 'None', vendor: 'N', versions: versions([]) },
  'acp:nohello': {
    kind: 'acp:nohello',
    tier: 'basic',
    label: 'NoHello',
    vendor: 'H',
    versions: versions([]),
    admission: { privacyGate: 'y' },
  },
  'acp:failed': { kind: 'acp:failed', tier: 'basic', label: 'Failed', vendor: 'D', versions: versions([]) },
};
const admission = {
  platform: 'macOS',
  how: 'Probed by hand.',
  harnesses: {
    full: {
      version: '2.0',
      probeWithQuirksFixes: { state: 'admitted', reason: 'a|b', version: '2.0-agent' },
      initialize: { agentCapabilities: { promptCapabilities: { image: true } } },
      privacyGate: { ok: true },
      sessionNew: { sageMcpHello: true },
    },
    nohello: { initialize: {}, privacyGate: { ok: false }, sessionNew: { ok: true } },
    failed: {
      initialize: { agentInfo: { version: '3.1' }, agentCapabilities: { promptCapabilities: { image: false } } },
      sessionNew: { ok: false },
    },
  },
};
const BIND = {
  goal: { via: 'rpc', method: 'thread/goal' },
  plan: { via: 'passthrough', template: '/plan|x' },
  review: { via: 'config', option: 'review', value: true },
  compact: { via: 'config', option: 'compact' },
  shell: { via: 'config', option: 'shell', value: 'zsh' },
  tasks: { via: 'polyfill', engine: 'tasks' },
  rename: { via: 'route', to: 'claude' },
  extra: { via: 'none', why: { code: 'harness.undeclared' } },
};
const inputs = (results: any[]) => ({
  REGISTRY,
  SEMANTICS: Object.keys(BIND),
  resolveCaps: ({ bindings }: any) => bindings,
  FEATURE_LABEL: Object.fromEntries(Object.keys(BIND).map((s) => [s, s.toUpperCase()])),
  whyText: (why: any, o: any) => `${o.label} lacks ${o.semantic} (${why.code})`,
  bindings: { codex: BIND, claude: BIND },
  results,
  admission,
});

test('conformance results load by file name, skipping other files', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'README.md'), 'x');
  fs.writeFileSync(
    path.join(dir, 'codex@1.0.0.json'),
    JSON.stringify({
      updatedAt: '2026-09-01T10:00:00Z',
      checks: [
        { id: 'X2', title: 't', verdict: 'pass' },
        { id: 'X3', title: 'u', verdict: 'pass' },
        { id: 'X4', verdict: 'fail' },
      ],
    }),
  );
  fs.writeFileSync(path.join(dir, 'claude@2.json'), JSON.stringify({ checks: [] }));
  const results = gen.loadResults(dir);
  assert.deepEqual(
    results.map((r: any) => [r.kind, r.version, r.date, r.counts]),
    [
      ['claude', '2', '', {}],
      ['codex', '1.0.0', '2026-09-01', { pass: 2, fail: 1 }],
    ],
  );
  assert.deepEqual(results[1].checks.X4, { title: undefined, verdict: 'fail' });
});

test('the matrix describes every binding kind, and a harness without a run as none', () => {
  const results = [
    {
      kind: 'codex',
      version: '1.0.0',
      file: 'conformance/results/codex@1.0.0.json',
      date: '2026-09-01',
      counts: { pass: 1 },
      checks: { X2: { verdict: 'pass' } },
    },
  ];
  const m = gen.assembleMatrix(inputs(results));
  assert.deepEqual(
    m.first.map((f: any) => f.result),
    [{ file: results[0].file, version: '1.0.0', date: '2026-09-01', counts: { pass: 1 } }, null],
  );
  const codex = Object.fromEntries(m.semantics.map((s: any) => [s.semantic, s.codex]));
  assert.deepEqual(codex.goal, { via: 'rpc', detail: 'thread/goal', source: 'Codex', verified: 'X2 pass' });
  assert.equal(codex.plan.verified, 'X3 missing');
  assert.equal(codex.review.detail, 'review');
  assert.equal(codex.compact.detail, 'compact');
  assert.equal(codex.shell.detail, 'shell = "zsh"');
  assert.deepEqual([codex.tasks.detail, codex.tasks.source], ['tasks', 'MoPilot']);
  assert.deepEqual([codex.rename.detail, codex.rename.source], ['Claude Code', 'Claude Code']);
  assert.deepEqual(codex.extra, {
    via: 'none',
    detail: 'harness.undeclared',
    source: '-',
    verified: '',
    why: 'Codex lacks extra (harness.undeclared)',
  });
  assert.equal(m.semantics[0].claude.verified, 'C4 missing, C17 missing, C18 missing');
  assert.equal(m.semantics[0].label, 'GOAL');
});

test('basic harnesses show their admission, image, privacy and tool-server results', () => {
  const m = gen.assembleMatrix(inputs([]));
  const by = Object.fromEntries(m.basic.map((b: any) => [b.id, b]));
  assert.deepEqual(by.full, {
    id: 'full',
    label: 'Full',
    vendor: 'F',
    probedVersion: '2.0',
    agentVersion: '2.0-agent',
    verified: '2.0',
    admission: 'admitted',
    reason: 'a|b',
    initialize: 'ok',
    imagePrompts: true,
    privacyGate: 'pass',
    sageTools: 'hello received',
    privacyDefaults: ['TELEMETRY=0'],
  });
  assert.deepEqual(by.none, {
    id: 'none',
    label: 'None',
    vendor: 'N',
    probedVersion: null,
    agentVersion: null,
    verified: 'unverified',
    admission: 'not probed',
    reason: null,
    initialize: 'not probed',
    imagePrompts: null,
    privacyGate: 'none declared',
    sageTools: 'not probed',
    privacyDefaults: [],
  });
  assert.deepEqual(
    [by.nohello.privacyGate, by.nohello.sageTools, by.nohello.imagePrompts, by.nohello.initialize],
    ['fail', 'no hello', null, 'ok'],
  );
  assert.deepEqual([by.failed.sageTools, by.failed.imagePrompts], ['session/new failed', false]);
  // without a probe result, the version initialize reported
  assert.equal(by.failed.agentVersion, '3.1');
  assert.equal(m.admissionPlatform, 'macOS');
});

test('the markdown escapes pipes and spells out empty cells', () => {
  const md = gen.renderMarkdown(
    gen.assembleMatrix(inputs([{ kind: 'codex', version: '1.0.0', file: 'f.json', date: 'd', counts: { pass: 2, fail: 1 }, checks: {} }])),
  );
  assert.match(md, /\| Codex \| npm \| `1\.0\.0` \| `0\.9\.0` \| `1\.0\.0` \| `f\.json` \(d\): 2 pass, 1 fail \|/);
  assert.match(md, /\| Claude Code \| npm \|  \| none \|  \| none \|/);
  assert.match(md, /\| PLAN \(`plan`\) \| native \(passthrough\) `\/plan\\\|x` \|/);
  assert.match(md, /\| TASKS \(`tasks`\) \| polyfill `tasks` \| MoPilot \| X10 missing \|/);
  assert.match(md, /\| EXTRA \(`extra`\) \| none: Codex lacks extra \(harness\.undeclared\) \| - \| - \|/);
  assert.match(md, /\| Full \(F\) \| `2\.0` \| 2\.0 \| admitted \| a\\\|b \| ok \| yes \| pass \| hello received \|/);
  assert.match(md, /\| None \(N\) \| - \| unverified \| not probed \| - \| not probed \| - \| none declared \| not probed \|/);
  assert.match(md, /\| Failed \(D\) \| - \| unverified \| not probed \| - \| ok \| no \| none declared \| session\/new failed \|/);
  assert.match(md, /Probed on macOS\. Probed by hand\./);
  assert.match(md, /Every other harness \(Full, None, NoHello, Failed\) runs through/);
});

test('extensionless relative imports resolve to their .ts file; other failures pass through', () => {
  const next = recorder((s: string) => {
    if (!s.endsWith('.ts')) throw new Error(`no ${s}`);
    return { url: s };
  });
  assert.deepEqual(gen.resolveTs('./a', {}, next), { url: './a.ts' });
  assert.deepEqual(gen.resolveTs('./b.ts', {}, next), { url: './b.ts' });
  assert.throws(() => gen.resolveTs('pkg', {}, next), /no pkg/);
  assert.throws(
    () =>
      gen.resolveTs('./c.ts', {}, () => {
        throw new Error('gone');
      }),
    /gone/,
  );
});

test('the command line writes both files, and --check names the stale ones', async () => {
  const build = async () => gen.assembleMatrix(inputs([]));
  const disk = new Map<string, string>();
  const fsx = {
    existsSync: (f: string) => disk.has(f),
    readFileSync: (f: string) => disk.get(f),
    writeFileSync: (f: string, t: string) => disk.set(f, t),
  };
  const error = recorder();
  assert.equal(await gen.main(['--check'], { build, fsx: fsx as any, error }), 1);
  assert.deepEqual(error.calls, [['stale: docs/harness-matrix.md, src/harness/matrix.generated.json; run npm run harness-matrix']]);
  const log = recorder();
  assert.equal(await gen.main([], { build, fsx: fsx as any, log }), 0);
  assert.deepEqual(log.calls, [['docs/harness-matrix.md\nsrc/harness/matrix.generated.json']]);
  assert.equal(disk.get(gen.OUT_JSON), gen.renderJson(await build()));
  assert.equal(await gen.main(['--check'], { build, fsx: fsx as any, error }), 0);
  disk.set(gen.OUT_MD, 'edited');
  assert.equal(await gen.main(['--check'], { build, fsx: fsx as any, error }), 1);
  assert.equal(error.calls[1][0], 'stale: docs/harness-matrix.md; run npm run harness-matrix');
});

test('run directly with --help, it prints the usage and builds nothing', () => {
  const r = runScript('scripts/gen-matrix.mjs', ['--help']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'usage: npm run harness-matrix [-- --check]\n');
});

test('version contract runs load from their folder, sort by harness then newest version, and show in the markdown', () => {
  const dir = tempDir();
  assert.deepEqual(gen.loadContracts(path.join(dir, 'none')), [], 'no folder: no runs yet');
  const write = (f: string, d: object) => fs.writeFileSync(path.join(dir, f), JSON.stringify(d));
  write('codex@1.0.0.json', {
    kind: 'codex',
    label: 'Codex',
    version: '1.0.0',
    verdict: 'pass',
    finishedAt: '2026-10-17T03:00:00Z',
    regressions: [],
    known: ['edge:codex:tls'],
    failingRows: [],
    incomplete: [],
  });
  write('codex@1.10.0.json', {
    kind: 'codex',
    label: 'Codex',
    version: '1.10.0',
    verdict: 'fail',
    finishedAt: '2026-10-18T04:00:00Z',
    regressions: ['edge:codex:hang'],
    known: [],
    failingRows: ['CM-L16'],
    incomplete: [],
  });
  write('acp-full@2.0.json', {
    kind: 'acp:full',
    label: 'Full',
    version: '2.0',
    verdict: 'incomplete',
    incomplete: ['acp: needs a sign-in | here'],
  });
  write('claude@1.0.0.json', {
    kind: 'claude',
    label: 'Claude Code',
    version: '1.0.0',
    verdict: 'pass',
    finishedAt: '2026-10-17T05:00:00Z',
    // no regressions list at all: every failing item is known
    known: ['edge:claude:tls'],
  });
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
  const findings = {
    'edge:codex:hang': { says: 'A hung page was left waiting.', issue: 7 },
    'edge:tls': { says: 'A certificate notice did nothing.', fixedBy: 8 },
  };
  let reads = 0;
  const loaded = gen.loadContracts(dir, () => (reads++, findings));
  assert.equal(reads, 1, 'the findings are read once, for the first failing item');
  assert.equal(loaded.length, 4);
  const full = loaded.find((c: any) => c.kind === 'acp:full');
  assert.deepEqual(full, {
    kind: 'acp:full',
    label: 'Full',
    version: '2.0',
    verdict: 'incomplete',
    date: '',
    regressions: 0,
    known: 0,
    failingRows: [],
    found: [],
    incomplete: ['acp: needs a sign-in | here'],
  });
  // its own key first, then the scenario on any cell
  assert.deepEqual(loaded.find((c: any) => c.version === '1.0.0' && c.kind === 'codex')!.found, [
    { key: 'edge:codex:tls', says: 'A certificate notice did nothing.', fixedBy: 8, known: true },
  ]);
  assert.deepEqual(loaded.find((c: any) => c.kind === 'claude')!.found, [
    { key: 'edge:claude:tls', says: 'A certificate notice did nothing.', fixedBy: 8, known: true },
  ]);
  const m = gen.assembleMatrix({ ...inputs([]), contracts: loaded });
  assert.deepEqual(
    m.contracts.map((c: any) => `${c.kind}@${c.version}`),
    ['codex@1.10.0', 'codex@1.0.0', 'claude@1.0.0', 'acp:full@2.0'],
  );
  assert.deepEqual(m.contracts[0], {
    kind: 'codex',
    label: 'Codex',
    version: '1.10.0',
    verdict: 'fail',
    date: '2026-10-18',
    regressions: 1,
    known: 0,
    failingRows: ['CM-L16'],
    found: [{ key: 'edge:codex:hang', says: 'A hung page was left waiting.', issue: 7 }],
    incomplete: [],
  });
  const md = gen.renderMarkdown(m);
  assert.match(md, /## Version contract\n\nEach new harness version is checked in the benchmark VM/);
  assert.match(md, /\| Codex \| `1\.10\.0` \| fail \| 2026-10-18 \| 1 \| 0 \| CM-L16 \|/);
  assert.match(md, /\| Codex \| `1\.0\.0` \| pass \| 2026-10-17 \| 0 \| 1 \| - \|/);
  assert.match(md, /\| Full \| `2\.0` \| incomplete: acp: needs a sign-in \\\| here \|  \| 0 \| 0 \| - \|/);
  assert.match(gen.renderMarkdown(gen.assembleMatrix(inputs([]))), /## Version contract\n\n.*\n\nNo contract run yet\./);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a contract file the page could not show stops the generator and names itself; a removed harness is left out', () => {
  const dir = tempDir();
  fs.writeFileSync(
    path.join(dir, 'codex@1.0.0.json'),
    JSON.stringify({ kind: 'codex', label: 'Codex', version: '1.0.0', verdict: 'error' }),
  );
  assert.throws(() => gen.loadContracts(dir), /codex@1\.0\.0\.json is not a contract result/);
  for (const bad of [
    { label: 'X', version: '1', verdict: 'pass' },
    { kind: 'codex', version: '1', verdict: 'pass' },
    { kind: 'codex', label: 'X', verdict: 'pass' },
    null,
  ]) {
    fs.writeFileSync(path.join(dir, 'codex@1.0.0.json'), JSON.stringify(bad));
    assert.throws(() => gen.loadContracts(dir), /not a contract result/);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  // a failing item nobody described stops the generator and names the file and the item
  const runs = tempDir();
  fs.writeFileSync(
    path.join(runs, 'codex@2.0.0.json'),
    JSON.stringify({ kind: 'codex', label: 'Codex', version: '2.0.0', verdict: 'fail', regressions: ['conformance:X9'] }),
  );
  assert.throws(
    () => gen.loadContracts(runs, () => ({ 'conformance:X1': { says: 'x', issue: 1 } })),
    /codex@2\.0\.0\.json: conformance:X9 failed; describe it in tests\/conformance\/results\/contract-findings\.json/,
  );
  // not inherited from Object: a key like "constructor" is a missing finding, not a function
  assert.equal(gen.findingFor({}, 'constructor'), undefined);
  assert.equal(gen.findingFor({}, 'edge:codex:toString'), undefined);
  fs.rmSync(runs, { recursive: true, force: true });
  const gone = {
    kind: 'acp:gone',
    label: 'Gone',
    version: '1.0',
    verdict: 'pass',
    date: '',
    regressions: 0,
    known: 0,
    failingRows: [],
    incomplete: [],
  };
  assert.deepEqual(gen.assembleMatrix({ ...inputs([]), contracts: [gone] }).contracts, []);
});

test('the findings file: every entry says something and names its issue or fix; the committed one loads', () => {
  const dir = tempDir();
  const file = path.join(dir, 'findings.json');
  const write = (d: unknown) => fs.writeFileSync(file, JSON.stringify(d));
  write({ findings: { 'conformance:X4': { says: 'Wrote config.', issue: 1346 }, 'edge:tls': { says: 'Did nothing.', fixedBy: 1348 } } });
  assert.deepEqual(Object.keys(gen.loadFindings(file)), ['conformance:X4', 'edge:tls']);
  for (const bad of [
    { says: '', issue: 1 },
    { says: '  ', issue: 1 },
    { issue: 1 },
    { says: 'x' },
    { says: 'x', issue: '1' },
    { says: 'x', fixedBy: 1.5 },
    null,
  ]) {
    write({ findings: { k: bad } });
    assert.throws(() => gen.loadFindings(file), /: k needs says \(a sentence\) and an issue or fixedBy number/, JSON.stringify(bad));
  }
  write({ about: 'no findings' });
  assert.throws(() => gen.loadFindings(file), /findings\.json has no findings object/);
  fs.rmSync(dir, { recursive: true, force: true });
  // the committed file, and every failing item of the committed runs has its words
  assert.ok(Object.keys(gen.loadFindings()).length > 0);
  assert.ok(gen.loadContracts().every((c: any) => c.found.length === c.regressions + c.known));
});
