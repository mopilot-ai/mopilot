// scripts/chromium-locales.mjs on staged app folders on disk: which of Electron's Chromium locales a package keeps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { keptLocale, localeFolders, stripChromiumLocales } = await import('../scripts/chromium-locales.mjs');
const { LANGUAGES, languageOfLocale } = await import('../shared/i18n/languages.mjs');

// Electron 44's Chromium locales (the macOS framework's, without the gendered variants): 55
const CHROMIUM = (
  'af am ar bg bn ca cs da de el en en_GB es es_419 et fa fi fil fr gu he hi hr hu id it ja kn ko lt lv ml mr ms nb nl pl ' +
  'pt_BR pt_PT ro ru sk sl sr sv sw ta te th tr uk ur vi zh_CN zh_TW'
).split(' ');
const SERVED = ['de', 'en', 'en_GB', 'es', 'es_419', 'fr', 'id', 'it', 'ja', 'ko', 'pt_BR', 'pt_PT', 'ru', 'zh_CN', 'zh_TW'];
const GENDERS = ['', '_FEMININE', '_MASCULINE', '_NEUTER'];

function stage(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'chromium-locales-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('the locales kept are the ones an interface language serves, every English one and every gendered variant included', () => {
  assert.deepEqual(CHROMIUM.filter(keptLocale), SERVED);
  // each interface language keeps at least one Chromium locale, so none is left without Chromium's own strings
  for (const { tag } of LANGUAGES)
    assert.ok(
      CHROMIUM.some((l) => languageOfLocale(l) === tag),
      tag,
    );
  for (const g of GENDERS.slice(1)) {
    assert.equal(keptLocale(`zh_TW${g}`), true);
    assert.equal(keptLocale(`th${g}`), false);
  }
  // Windows and Linux name them with hyphens
  for (const l of ['en-US', 'en-GB', 'es-419', 'pt-PT', 'zh-CN', 'zh-TW']) assert.equal(keptLocale(l), true, l);
  for (const l of ['nl', 'fil', 'nb', 'sr']) assert.equal(keptLocale(l), false, l);
});

test('macOS: the framework and the app keep the same languages, and the app is otherwise untouched', (t) => {
  const contents = path.join(stage(t), 'MoPilot.app', 'Contents');
  const buildPath = path.join(contents, 'Resources', 'app');
  const [framework, resources] = localeFolders('darwin', buildPath).map((f: { dir: string }) => f.dir);
  assert.equal(framework, path.join(contents, 'Frameworks', 'Electron Framework.framework', 'Resources'));
  assert.equal(resources, path.join(contents, 'Resources'));
  for (const l of CHROMIUM) {
    for (const g of GENDERS) {
      mkdirSync(path.join(framework, `${l}${g}.lproj`), { recursive: true });
      writeFileSync(path.join(framework, `${l}${g}.lproj`, 'locale.pak'), 'pak');
    }
    mkdirSync(path.join(resources, `${l}.lproj`), { recursive: true });
  }
  writeFileSync(path.join(framework, 'resources.pak'), 'pak');
  mkdirSync(buildPath, { recursive: true });
  writeFileSync(path.join(resources, 'electron.icns'), 'icon');

  assert.deepEqual(stripChromiumLocales({ platform: 'darwin', buildPath }), { kept: 15 * 4 + 15, removed: 40 * 4 + 40 });
  const lproj = (dir: string) =>
    readdirSync(dir)
      .filter((n) => n.endsWith('.lproj'))
      .sort();
  assert.deepEqual(lproj(framework), SERVED.flatMap((l) => GENDERS.map((g) => `${l}${g}.lproj`)).sort());
  assert.deepEqual(lproj(resources), SERVED.map((l) => `${l}.lproj`).sort());
  assert.ok(readdirSync(framework).includes('resources.pak'));
  assert.deepEqual(
    readdirSync(resources)
      .filter((n) => !n.endsWith('.lproj'))
      .sort(),
    ['app', 'electron.icns'],
  );
});

test('Windows and Linux: locales/ beside the executable keeps its served .pak files, en-US among them', (t) => {
  for (const platform of ['win32', 'linux'] as const) {
    const out = stage(t);
    const buildPath = path.join(out, 'resources', 'app');
    const locales = path.join(out, 'locales');
    mkdirSync(locales, { recursive: true });
    for (const l of ['en-US', 'en-GB', 'de', 'nl', 'pt-PT', 'th', 'zh-TW']) writeFileSync(path.join(locales, `${l}.pak`), 'pak');
    writeFileSync(path.join(locales, 'README'), 'not a locale');
    assert.deepEqual(localeFolders(platform, buildPath), [{ dir: locales, suffix: '.pak' }]);
    assert.deepEqual(stripChromiumLocales({ platform, buildPath }), { kept: 5, removed: 2 });
    assert.deepEqual(readdirSync(locales).sort(), ['README', 'de.pak', 'en-GB.pak', 'en-US.pak', 'pt-PT.pak', 'zh-TW.pak']);
  }
});

test('a folder with no English locale is refused before anything is removed from it', (t) => {
  const out = stage(t);
  const locales = path.join(out, 'locales');
  mkdirSync(locales, { recursive: true });
  for (const l of ['de', 'th']) writeFileSync(path.join(locales, `${l}.pak`), 'pak');
  assert.throws(
    () => stripChromiumLocales({ platform: 'win32', buildPath: path.join(out, 'resources', 'app') }),
    /^Error: No English Chromium locale \(\*\.pak\) in .*locales: Electron's layout changed, so no locale was removed\.$/,
  );
  assert.deepEqual(readdirSync(locales).sort(), ['de.pak', 'th.pak']);
  // an empty or renamed folder too: a package would otherwise ship every locale without anyone noticing
  rmSync(path.join(locales, 'de.pak'));
  rmSync(path.join(locales, 'th.pak'));
  assert.throws(() => stripChromiumLocales({ platform: 'linux', buildPath: path.join(out, 'resources', 'app') }), /No English/);
});
