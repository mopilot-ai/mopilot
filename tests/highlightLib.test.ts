// The lazy Shiki highlighter: language aliases, unknown languages, caching and line tokens.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const created: any[] = [];
let failStartup = false;
let startupAttempts = 0;
const loads: string[] = [];
const failures = new Set<string>();
const fakeHl = {
  loadLanguage: async (l: string) => {
    loads.push(l);
    if (l === 'broken' || failures.has(l)) throw new Error('no grammar');
  },
  codeToHtml: (code: string, o: any) => {
    fakeHl.htmlCalls++;
    return `<pre data-lang="${o.lang}" data-theme="${o.theme}">${code}</pre>`;
  },
  codeToTokensBase: (code: string, o: any) =>
    code.split('\n').map((t) => [{ content: t, color: o.lang === 'text' ? undefined : `${o.theme}:${o.lang}` }]),
  htmlCalls: 0,
};
mock.module('shiki', {
  namedExports: {
    createHighlighter: async (opts: any) => {
      startupAttempts++;
      if (failStartup) throw new Error('temporary startup failure');
      created.push(opts);
      return fakeHl;
    },
    bundledLanguages: { typescript: 1, bash: 1, python: 1, rust: 1, broken: 1 },
  },
});
const { highlight, langFromPath, tokenizeLines } = await import('../src/lib/highlight.ts');

test('a failed shared highlighter startup retries and then remains shared', async () => {
  failStartup = true;
  try {
    await Promise.all([
      assert.rejects(highlight('startup retry', 'text', true), /temporary startup failure/),
      assert.rejects(tokenizeLines('startup retry', 'text', false), /temporary startup failure/),
    ]);
    assert.equal(startupAttempts, 1);
  } finally {
    failStartup = false;
  }
  assert.deepEqual(await tokenizeLines('recovered', 'text', true), [[['recovered', '']]]);
  assert.equal(startupAttempts, 2);
  assert.deepEqual(await tokenizeLines('shared', 'text', false), [[['shared', '']]]);
  assert.equal(startupAttempts, 2);
});

test('a file path names its language', () => {
  assert.equal(langFromPath('src/a.TS'), 'typescript');
  assert.equal(langFromPath('x/Dockerfile'), 'dockerfile');
  assert.equal(langFromPath('main.tf'), 'hcl');
  assert.equal(langFromPath('README'), 'text');
  assert.equal(langFromPath('weird.zzz'), 'text');
});

test('code is highlighted once per theme and language, through aliases, with one shared highlighter', async () => {
  const html = await highlight('echo hi', 'SH', true);
  assert.equal(html, '<pre data-lang="bash" data-theme="codex-dark">echo hi</pre>');
  assert.equal(await highlight('echo hi', 'SH', true), html);
  assert.equal(fakeHl.htmlCalls, 1); // cached
  assert.match(await highlight('echo hi', 'sh', false), /codex-light/);
  assert.deepEqual(loads, ['bash']); // the grammar loads once
  assert.equal(created.length, 1);
  assert.deepEqual(
    created[0].themes.map((t: any) => t.name),
    ['codex-dark', 'codex-light'],
  );
});

test('unknown, empty and broken languages fall back to plain text', async () => {
  assert.match(await highlight('x', 'klingon', true), /data-lang="text"/);
  assert.match(await highlight('y', '', true), /data-lang="text"/);
  assert.match(await highlight('z', 'broken', true), /data-lang="text"/);
  assert.ok(loads.includes('broken'));
});

test('the cache is bounded', async () => {
  for (let i = 0; i < 405; i++) await highlight(`line ${i}`, 'text', true);
  const before = fakeHl.htmlCalls;
  await highlight('line 0', 'text', true); // evicted when the cache was cleared
  assert.equal(fakeHl.htmlCalls, before + 1);
});

test('code past the cache size is colored again each time, so a large file edited in place does not fill the caches', async () => {
  const { CACHED_CODE_MAX } = await import('../src/lib/highlightCache.ts');
  const big = 'x'.repeat(CACHED_CODE_MAX + 1);
  const before = fakeHl.htmlCalls;
  await highlight(big, 'text', true);
  await highlight(big, 'text', true);
  assert.equal(fakeHl.htmlCalls, before + 2);
});

test('lines tokenize into [text, color] pairs', async () => {
  assert.deepEqual(await tokenizeLines('a\nb', 'py', false), [[['a', 'codex-light:python']], [['b', 'codex-light:python']]]);
  assert.deepEqual(await tokenizeLines('a', 'text', true), [[['a', '']]]);
});

test('prototype-named filenames and language labels fall back to plain text without loading a grammar', async () => {
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const language = langFromPath(`file.${name}`);
    assert.equal(language, 'text');
    assert.match(await highlight(`preview ${name}`, language, true), /data-lang="text"/);
    const before = loads.length;
    assert.match(await highlight(`fence ${name}`, name, false), /data-lang="text"/);
    assert.deepEqual(await tokenizeLines('literal', name, true), [[['literal', '']]]);
    assert.equal(loads.length, before);
  }
});

test('highlight cache keys distinguish language delimiters from code content', async () => {
  for (const dark of [true, false]) {
    const theme = dark ? 'codex-dark' : 'codex-light';
    const before = fakeHl.htmlCalls;
    const typed = await highlight('scope:cache-body', 'ts', dark);
    const plain = await highlight('cache-body', 'ts:scope', dark);
    assert.equal(typed, `<pre data-lang="typescript" data-theme="${theme}">scope:cache-body</pre>`);
    assert.equal(plain, `<pre data-lang="text" data-theme="${theme}">cache-body</pre>`);
    assert.equal(fakeHl.htmlCalls, before + 2);
    assert.equal(await highlight('scope:cache-body', 'ts', dark), typed);
    assert.equal(await highlight('cache-body', 'ts:scope', dark), plain);
    assert.equal(fakeHl.htmlCalls, before + 2);
  }
});

test('a failed grammar load can recover for the same code block and alias', async () => {
  const code = 'fn recovered() {}';
  const before = loads.length;
  failures.add('rust');
  try {
    assert.match(await highlight(code, 'rs', true), /data-lang="text"/);
  } finally {
    failures.delete('rust');
  }
  const recovered = await highlight(code, 'rs', true);
  assert.match(recovered, /data-lang="rust"/);
  assert.deepEqual(loads.slice(before), ['rust', 'rust']);
  const calls = fakeHl.htmlCalls;
  assert.equal(await highlight(code, 'rs', true), recovered);
  assert.equal(fakeHl.htmlCalls, calls);
  assert.match(await highlight('fn next() {}', 'rust', false), /data-lang="rust"/);
  assert.equal(loads.length, before + 2);
});
