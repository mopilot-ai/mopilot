// Every language catalog can only ever show a complete sentence, and no interface logic reads what a catalog replaces (docs/i18n.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGUAGES } from '../shared/i18n/languages.mjs';
import { catalogProblems, catalogReport, MAIN_SOURCES, reportLines, sourceMessages } from '../scripts/i18n/catalog.mjs';
import { isInterfaceText, objectTextIn } from '../scripts/i18n/transform.mjs';
import { execFileSync } from 'node:child_process';

export const GUARDS = ['src/', 'shared/i18n/', 'scripts/i18n/'];

const root = fileURLToPath(new URL('..', import.meta.url));
const LOCALES = path.join(root, 'shared/i18n/locales');
const others = LANGUAGES.filter((l) => l.tag !== 'en');

test('every language but English has a catalog', () => {
  for (const { tag } of others) assert.ok(existsSync(path.join(LOCALES, `${tag}.json`)), tag);
});

test('no catalog drops a value or shows an empty string', () => {
  for (const { tag } of others) {
    const catalog = JSON.parse(readFileSync(path.join(LOCALES, `${tag}.json`), 'utf8'));
    assert.deepEqual(catalogProblems(catalog), [], tag);
  }
});

test('current interface catalogs name the app MoPilot in both lookup keys and translated labels', () => {
  for (const { tag } of others) {
    const source = readFileSync(path.join(LOCALES, `${tag}.json`), 'utf8');
    assert.doesNotMatch(source, /\bMoPilot[ -]Code\b/, tag);
    assert.ok(Object.hasOwn(JSON.parse(source), 'Quit MoPilot?'), `${tag}: the renamed label remains translated`);
  }
});

test('a catalog entry with other holes than its English, or no text, is a problem', () => {
  assert.equal(catalogProblems({ 'Open {0}': '打开' }).length, 1);
  assert.equal(catalogProblems({ 'Open {0}': '打开 {1}' }).length, 1);
  assert.equal(catalogProblems({ Open: ' ' }).length, 1);
  assert.equal(catalogProblems({ Open: 3 }).length, 1);
  assert.equal(catalogProblems({ 'Off in {label}': 'Off in {etiqueta}' }).length, 1);
  assert.equal(catalogProblems({ 'Pauses  ☐ Continue': '暂停 继续' }).length, 1, 'a line code splits on its mark');
  assert.equal(catalogProblems({ 'Off · Turn on': '关闭，开启' }).length, 1);
  assert.deepEqual(catalogProblems({ 'Move {0} to {1}': '{1} 到 {0}' }), []);
});

test('the report counts what each language covers, what is missing and what no source says any more', () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'i18n-report-'));
  for (const file of ['src/components/a.tsx', MAIN_SOURCES[0], 'shared/i18n/locales/ja.json'])
    mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
  writeFileSync(path.join(fixture, 'src/components/a.tsx'), 'export const V = () => <b>Hello there</b>;');
  writeFileSync(path.join(fixture, 'src/components/a.test.tsx'), 'export const V = () => <b>Only a test</b>;');
  writeFileSync(path.join(fixture, MAIN_SOURCES[0]), "t('Quit now');");
  writeFileSync(path.join(fixture, 'shared/i18n/locales/ja.json'), JSON.stringify({ 'Hello there': 'こんにちは', Gone: 'x' }));
  assert.deepEqual(sourceMessages(fixture), ['Hello there', 'Quit now']);
  const report = catalogReport(fixture);
  assert.deepEqual(
    report.find((l) => l.tag === 'ja'),
    { tag: 'ja', translated: 1, missing: ['Quit now'], stale: ['Gone'], problems: [] },
  );
  assert.equal(report.find((l) => l.tag === 'ko')?.translated, 0);
});

test('a language with a problem fails the check, with the problem named; one that is merely behind does not', () => {
  const language = { tag: 'ja', translated: 1, missing: ['x'], stale: [], problems: [] };
  assert.deepEqual(reportLines([language], 2), { lines: ['ja       1/2 messages, 0 stale, 0 problems'], ok: true });
  const { lines, ok } = reportLines([{ ...language, problems: ['no text for "x"'] }], 2);
  assert.equal(ok, false);
  assert.equal(lines.at(-1), 'ja: no text for "x"');
});

test('the check command reports each language and lists what one lacks', () => {
  const run = (...args: string[]) => execFileSync(process.execPath, ['scripts/i18n/check.mjs', ...args], { cwd: root, encoding: 'utf8' });
  assert.match(run(), /^zh-Hans +\d+\/\d+ messages/m);
  assert.ok(Array.isArray(JSON.parse(run('--missing', 'ja'))));
  assert.throws(() => run('--missing', 'klingon'), /No language klingon/);
});

const interfaceFiles = () =>
  execFileSync('git', ['ls-files', 'src'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\./.test(file) && objectTextIn(file));

test('what the app itself sends an agent stays as written: a function of this file that feeds a send says so by its name', () => {
  const offenders = interfaceFiles().flatMap((file) => {
    const source = readFileSync(path.join(root, file), 'utf8');
    const local = (name: string) => new RegExp(`(?:function|const) ${name}\\b`).test(source);
    // the send's own argument, or the call a local \`const text = …(\` took it from
    const direct = [...source.matchAll(/\b(?:sendMessage|sendOrDraft|chatProxy\.send)\([^,]+,\s*(\w+)\(/g)].map(([, name]) => name);
    const held = [...source.matchAll(/\b(?:sendMessage|sendOrDraft|chatProxy\.send)\([^,]+,\s*(\w+)\s*[,)]/g)].flatMap(([, name]) =>
      [...source.matchAll(new RegExp(`const ${name} = (\\w+)\\(`, 'g'))].map(([, fn]) => fn),
    );
    return [...direct, ...held].filter((name) => local(name) && !/Prompt$/.test(name)).map((name) => `${file}: ${name}`);
  });
  assert.deepEqual(offenders, []);
  const messages = sourceMessages(root);
  for (const sent of [
    "I'm done in {0}. Continue the task from where you handed it to me, and check the page again first.",
    'Plan ({0}), line {1}:\n{2}',
  ])
    assert.ok(!messages.includes(sent), sent);
});

test('no stylesheet selects on text a catalog replaces', () => {
  const sheets = execFileSync('git', ['ls-files', 'src'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((file) => file.endsWith('.css'));
  const offenders = sheets.filter((file) =>
    /\[(?:aria-label|title|placeholder|alt)[~|^$*]?=/.test(readFileSync(path.join(root, file), 'utf8')),
  );
  assert.deepEqual(offenders, []);
});

/** `x.label === 'Save'` in a file whose objects are translated: the label holds the translation, the literal does not. */
const DISPLAY_COMPARE =
  /(?<!typeof [\w.?]*)\.(?:label|title|desc|description|detail|hint|subtitle|tooltip)\)?\s*(?:===|!==)\s*['"`]([^'"`]*)/g;

test('interface logic never compares a translated field to English: it reads an id or a flag', () => {
  const offenders = interfaceFiles().flatMap((file) =>
    readFileSync(path.join(root, file), 'utf8')
      .split('\n')
      .flatMap((line, i) =>
        // a command or an id is never wrapped, so comparing one is safe
        [...line.matchAll(DISPLAY_COMPARE)].filter(([, literal]) => isInterfaceText(literal)).map(() => `${file}:${i + 1}`),
      ),
  );
  assert.deepEqual(offenders, []);
});
