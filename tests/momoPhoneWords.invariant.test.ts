// MoMo's phone words all come from the app's catalog: every key the home screens use is in English and Simplified Chinese, no screen shows a literal, and the words follow the language shown.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from '../mobile/node_modules/typescript/lib/typescript.js';
import { uiLiterals } from './support/phone/uiLiterals.ts';

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const enPath = '../mobile/src/ui/i18n/locales/en.ts';
const zhPath = '../mobile/src/ui/i18n/locales/zh-Hans.ts';
const i18nPath = '../mobile/src/ui/i18n';
const sayPath = '../mobile/src/momoPhone/say';
const vmPath = '../mobile/src/momoPhone/viewModels';
const workPath = '../mobile/src/momoPhone/workModels';
const fxPath = '../mobile/src/momoPhone/fixtures';
const en = ((await import(enPath)) as { default: { momoHome: Record<string, string> } }).default.momoHome;
const zh = ((await import(zhPath)) as { default: { momoHome: Record<string, string> } }).default.momoHome;
const i18n = await import(i18nPath);
const vm = await import(vmPath);
const work = await import(workPath);
const { fixtureView } = await import(fxPath);

const files = [...walk('mobile/src/momoPhone'), ...walk('mobile/src/screens/momoPhone')].filter((f) => /\.tsx?$/.test(f));
const used = new Set(files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/\bsay\('([A-Za-z0-9_]+)'/g)].map((m) => m[1])));
// keys built from a number or a choice: the twelve months, and the AM and PM of a clock
for (let i = 1; i <= 12; i++) used.add(`month${i}`);
used.add('timeAm').add('timePm');

test('every key the home screens use is in both languages, and none is left unused', () => {
  const has = (c: Record<string, string>, key: string) => key in c || `${key}_one` in c || `${key}_other` in c;
  assert.deepEqual(
    [...used].filter((k) => !has(en, k) || !has(zh, k)),
    [],
  );
  const names = new Set([...used]);
  const stray = Object.keys(en).filter((k) => !names.has(k.replace(/_(one|other)$/, '')) && !['chat'].includes(k));
  assert.deepEqual(stray, [], 'a line nothing shows');
});

test('no home screen shows a literal that is not a catalog key', () => {
  const bad = files
    .filter((f) => f.endsWith('.tsx'))
    .flatMap((f) =>
      uiLiterals(readFileSync(f, 'utf8'), f)
        .filter((t) => !/^[·←→↑↓‹›✓●○…−+\s]+$/.test(t))
        .map((t) => `${f}: ${t}`),
    );
  assert.deepEqual(bad, []);
});

test('the words follow the language shown, and come back with it', async () => {
  const view = fixtureView();
  view.view.home.state = 'asleep';
  view.view.home.stateSince = new Date(2026, 10, 24, 13, 12).getTime();
  assert.equal(vm.headerPill(view).hint, 'Studio is asleep');
  assert.equal(vm.homeBanner(view).actions[0].label, 'Wake Studio');
  await i18n.showLocale('zh-Hans');
  try {
    assert.equal(vm.headerPill(view).hint, 'Studio已休眠');
    assert.equal(vm.homeBanner(view).actions[0].label, '唤醒Studio');
    assert.equal(vm.homeBanner(view).title, 'MoMo 的家在 下午1:12 休眠了');
    assert.equal(work.taskSections([]).empty.title, '没有正在运行的任务。');
    assert.equal(work.lineBadge({ status: 'confirmed' }), '已确认');
    assert.equal(vm.whereRows(fixtureView()).here.subtitle, 'MoMo 在这里');
    assert.equal(work.clampCap(3), 3);
  } finally {
    await i18n.showLocale('en');
  }
  assert.equal(vm.headerPill(view).hint, 'Studio is asleep');
});

test('plurals read right in both languages', async () => {
  const card = vm.briefCard(fixtureView(), {
    day: 'd',
    greeting: 'g',
    attention: null,
    offers: [],
    overnight: { read: 1, notesUpdated: 2, rulesLearned: 1 },
    leftOut: [],
  });
  assert.equal(card.overnight, 'Overnight on Studio: 1 message read, 2 notes updated, 1 rule learned.');
  assert.equal(
    vm.approvalView(
      { ...fixtureView().view.chat[2].approval, recipients: [1, 2].map((n) => ({ name: `P${n}`, address: 'a', outsideCompany: true })) },
      1,
    ).status,
    '2 people outside your company.',
  );
  await i18n.showLocale('zh-Hans');
  try {
    assert.equal(
      card.overnight,
      'Overnight on Studio: 1 message read, 2 notes updated, 1 rule learned.',
      'a computed line does not change by itself',
    );
    assert.match(
      vm.briefCard(fixtureView(), {
        day: 'd',
        greeting: 'g',
        attention: null,
        offers: [],
        overnight: { read: 3, notesUpdated: 1, rulesLearned: 0 },
        leftOut: [],
      }).overnight,
      /3 封邮件/,
    );
  } finally {
    await i18n.showLocale('en');
  }
});

/** Prose in a source file that does not go through `say`: a string or template of two words or more, outside a `say(...)` call, an import and the product's own names. */
function proseOutsideSay(source: string, file: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const p = node.parent;
      const inSay = ts.isCallExpression(p) && p.expression.getText() === 'say';
      const loads = ts.isImportDeclaration(p) || ts.isExportDeclaration(p);
      const text = node.text.replace(/Claude Code|Google Calendar/g, '');
      if (!inSay && !loads && /[A-Za-z]{3}.*\s.*[A-Za-z]{2}/.test(text)) found.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

test('no view model or transport says a word of its own: every line is a catalog key', () => {
  // the fixtures are the design's example data for the fake home, not words the screens say
  const own = files.filter((f) => f.endsWith('.ts') && !/fixtures\.ts$|homeCache\.ts$|say\.ts$/.test(f));
  const bad = own.flatMap((f) => proseOutsideSay(readFileSync(f, 'utf8'), f).map((t) => `${f}: ${t}`));
  assert.deepEqual(bad, []);
  assert.deepEqual(proseOutsideSay("const a = say('x y z'); const b = 'two words'; const c = `alpha beta gamma`;", 'x.ts'), [
    'two words',
    'alpha beta gamma',
  ]);
});

test('sentences join the way the shown language joins them', async () => {
  const say = await import(sayPath);
  assert.equal(say.sentences('One.', 'Two.'), 'One. Two.');
  await i18n.showLocale('zh-Hans');
  try {
    assert.equal(say.sentences('一。', '二。'), '一。二。');
  } finally {
    await i18n.showLocale('en');
  }
});
