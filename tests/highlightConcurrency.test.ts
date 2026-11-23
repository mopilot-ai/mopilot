// Equivalent concurrent highlighting and grammar loads share work, while failures stay retryable.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { deferred } from './support/async-scenarios.ts';

const loads: string[] = [];
const htmlCalls: string[] = [];
const grammars = new Map<string, ReturnType<typeof deferred<void>>>();
const started = new Map<string, ReturnType<typeof deferred<void>>>();
const syncFailures = new Set<string>();
let startupFails = true;
let htmlFails = false;
const highlighter = {
  loadLanguage: (language: string) => {
    loads.push(language);
    started.get(language)?.resolve();
    if (syncFailures.has(language)) throw new Error('synchronous grammar failure');
    return grammars.get(language)?.promise ?? Promise.resolve();
  },
  codeToHtml: (code: string, options: { lang: string; theme: string }) => {
    htmlCalls.push(JSON.stringify([code, options]));
    if (htmlFails) throw new Error('highlight failed');
    return JSON.stringify([code, options]);
  },
  codeToTokensBase: (code: string) => [[{ content: code }]],
};
mock.module('shiki', {
  namedExports: {
    bundledLanguages: { typescript: 1, bash: 1, rust: 1, python: 1, go: 1, ruby: 1, java: 1, cpp: 1, swift: 1 },
    createHighlighter: async () => {
      if (startupFails) throw new Error('startup failed');
      return highlighter;
    },
  },
});
const { highlight, tokenizeLines } = await import('../src/lib/highlight.ts');

test('concurrent identical requests share work and retry after shared startup failure', async () => {
  await Promise.all(Array.from({ length: 8 }, () => assert.rejects(highlight('same startup', 'text', true), /startup failed/)));
  startupFails = false;
  const before = htmlCalls.length;
  const results = await Promise.all(Array.from({ length: 32 }, () => highlight('same startup', 'text', true)));
  assert.equal(htmlCalls.length - before, 1);
  assert.equal(new Set(results).size, 1);
});

test('code blocks and diff tokens share an in-flight grammar, including aliases', async () => {
  const grammar = deferred<void>();
  grammars.set('typescript', grammar);
  const before = htmlCalls.length;
  const results = [highlight('typed one', 'ts', true), highlight('typed two', 'typescript', false), tokenizeLines('diff', 'ts', true)];
  await Promise.resolve();
  await Promise.resolve();
  grammar.resolve();
  await Promise.all(results);
  assert.equal(loads.filter((language) => language === 'typescript').length, 1);
  assert.equal(htmlCalls.length - before, 2, 'different code/theme requests remain separate');
});

test('a shared rejected grammar falls back once per equivalent request and retries on the next wave', async () => {
  const grammar = deferred<void>();
  grammars.set('rust', grammar);
  const before = htmlCalls.length;
  const results = Array.from({ length: 12 }, () => highlight('recover grammar', 'rs', true));
  await Promise.resolve();
  await Promise.resolve();
  grammar.reject(new Error('grammar unavailable'));
  assert.ok((await Promise.all(results)).every((html) => JSON.parse(html)[1].lang === 'text'));
  assert.equal(htmlCalls.length - before, 1);
  assert.equal(loads.filter((language) => language === 'rust').length, 1);
  grammars.delete('rust');
  const retry = await highlight('recover grammar', 'rs', true);
  assert.equal(JSON.parse(retry)[1].lang, 'rust');
  assert.equal(loads.filter((language) => language === 'rust').length, 2);
});

test('failed HTML generation rejects every waiter and does not poison a later request', async () => {
  htmlFails = true;
  const before = htmlCalls.length;
  try {
    await Promise.all(Array.from({ length: 6 }, () => assert.rejects(highlight('recover HTML', 'text', true), /highlight failed/)));
  } finally {
    htmlFails = false;
  }
  assert.equal(htmlCalls.length - before, 1);
  assert.equal(JSON.parse(await highlight('recover HTML', 'text', true))[0], 'recover HTML');
});

test('in-flight identity distinguishes theme, language and delimiter-bearing code', async () => {
  const requests: [string, string, boolean][] = [
    ['scope:body', 'ts', true],
    ['body', 'ts:scope', true],
    ['scope:body', 'ts', false],
    ['scope:body', 'text', true],
  ];
  const before = htmlCalls.length;
  const results = await Promise.all(requests.flatMap((args) => [highlight(...args), highlight(...args)]));
  assert.equal(htmlCalls.length - before, requests.length);
  for (let i = 0; i < requests.length; i++) assert.equal(results[i * 2], results[i * 2 + 1]);
  assert.equal(new Set(results).size, requests.length);
});

test('synchronously thrown grammar loads retire before a successful retry across code blocks and diffs', async () => {
  syncFailures.add('bash');
  try {
    const [html, tokens] = await Promise.all([highlight('sync failure', 'sh', true), tokenizeLines('sync diff', 'bash', true)]);
    assert.equal(JSON.parse(html)[1].lang, 'text');
    assert.deepEqual(tokens, [[['sync diff', '']]]);
    assert.equal(loads.filter((language) => language === 'bash').length, 1);
  } finally {
    syncFailures.delete('bash');
  }
  assert.equal(JSON.parse(await highlight('sync failure', 'sh', true))[1].lang, 'bash');
  assert.equal(loads.filter((language) => language === 'bash').length, 2);
});

test('different pending grammars finish independently in either order without losing another key', async () => {
  for (const [a, b, first] of [
    ['python', 'go', 'go'],
    ['ruby', 'java', 'ruby'],
  ]) {
    for (const language of [a, b]) {
      grammars.set(language, deferred<void>());
      started.set(language, deferred<void>());
    }
    const finished = new Set<string>();
    const requests = new Map(
      [a, b].map((language) => [
        language,
        Promise.all([highlight('independent', language, true), highlight('independent', language, true)]).then((results) => {
          finished.add(language);
          assert.equal(results[0], results[1]);
          assert.equal(JSON.parse(results[0])[1].lang, language);
        }),
      ]),
    );
    await Promise.all([started.get(a)!.promise, started.get(b)!.promise]);
    grammars.get(first)!.resolve();
    await requests.get(first);
    assert.deepEqual([...finished], [first]);
    const second = first === a ? b : a;
    grammars.get(second)!.resolve();
    await requests.get(second);
    assert.equal(loads.filter((language) => language === a).length, 1);
    assert.equal(loads.filter((language) => language === b).length, 1);
  }
});

test('one grammar can reject and retry while another grammar remains pending', async () => {
  for (const language of ['cpp', 'swift']) {
    grammars.set(language, deferred<void>());
    started.set(language, deferred<void>());
  }
  let otherFinished = false;
  const failed = highlight('retry independently', 'c++', true);
  const other = highlight('keep pending', 'swift', false).then((html) => {
    otherFinished = true;
    return html;
  });
  await Promise.all([started.get('cpp')!.promise, started.get('swift')!.promise]);
  grammars.get('cpp')!.reject(new Error('temporary grammar failure'));
  assert.equal(JSON.parse(await failed)[1].lang, 'text');
  assert.equal(otherFinished, false);
  grammars.delete('cpp');
  assert.equal(JSON.parse(await highlight('retry independently', 'c++', true))[1].lang, 'cpp');
  assert.equal(otherFinished, false);
  grammars.get('swift')!.resolve();
  assert.equal(JSON.parse(await other)[1].lang, 'swift');
  assert.equal(loads.filter((language) => language === 'cpp').length, 2);
  assert.equal(loads.filter((language) => language === 'swift').length, 1);
});
