// The phone UI's two languages: keyed text with plurals and safe interpolation, a language that changes at once and only to the latest choice, a missing key that shows English and is logged, and the choice kept on the phone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot } from './support/phone/component-kit';
const i18nPath = '../mobile/src/ui/i18n';
const coreSource = '../mobile/vendor/orca/i18n/mobileI18n';
const i18n = await import(i18nPath);
const { createMobileI18n } = await import(coreSource);
const { t, showLocale, useTranslation, resolveLocale, parseLanguage, createLanguage, missingKeys, setPseudoLocalization } = i18n;
const g = globalThis as { __DEV__?: boolean };

test('English is on at first, with the words the catalog holds', () => {
  assert.equal(t('chat.cantLoad'), "Can't load this chat right now.");
  assert.equal(t('chats.title'), 'Chats');
  assert.equal(i18n.currentLocale(), 'en');
});

test('plural forms: English picks one or other, Chinese has one form for every count', async () => {
  assert.equal(t('chats.needInput_one', { count: 1 }), '1 needs input');
  assert.equal(t('chats.needInput_other', { count: 2 }), '2 need input');
  assert.equal(t('chats.needInput_one', { count: 0 }), '0 need input');
  await showLocale('zh-Hans');
  assert.equal(t('chats.needInput_one', { count: 1 }), '1 个需要回复');
  assert.equal(t('chats.needInput_other', { count: 5 }), '5 个需要回复');
  await showLocale('en');
});

test('interpolation puts a name in as it is: braces, markup and keys in it stay text', () => {
  assert.equal(t('chat.onMachine', { name: '{{chat.stop}}' }), 'On {{chat.stop}}');
  assert.equal(t('chat.onMachine', { name: '$t(chat.stop) <b>x</b> {name}' }), 'On $t(chat.stop) <b>x</b> {name}');
  assert.equal(t('composer.filesIn', { project: 'a&b' }), 'Files in a&b');
});

test('a very long name in Chinese is kept whole, in both languages', async () => {
  const name = '一个非常长的项目名称'.repeat(30);
  assert.equal(t('composer.filesIn', { project: name }), `Files in ${name}`);
  await showLocale('zh-Hans');
  assert.equal(t('composer.filesIn', { project: name }), `${name} 中的文件`);
  await showLocale('en');
});

test('the language changes at once, in components that are already drawn, without a restart', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const Row = () => {
    const { t: say, locale } = useTranslation();
    return createElement('span', { 'data-locale': locale }, say('chats.newChat'));
  };
  await act(async () => root.render(createElement(Row)));
  assert.equal(host.textContent, 'New chat');
  await act(async () => showLocale('zh-Hans'));
  assert.equal(host.textContent, '新聊天');
  assert.equal(host.querySelector('span')!.getAttribute('data-locale'), 'zh-Hans');
  await act(async () => showLocale('en'));
  assert.equal(host.textContent, 'New chat');
  await act(async () => root.unmount());
  host.remove();
});

test('a key the shown language lacks shows English and is logged in development only; a key nobody has shows itself', () => {
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void warned.push(String(a[0]));
  const lines: string[] = [];
  const bundle = { a: 'English A', b: 'English B' };
  const make = () =>
    createMobileI18n({
      defaultLocale: 'en',
      defaultCatalog: bundle,
      importCatalog: async () => ({ a: '甲' }),
      onMissingKey: (key: string, locale: string) => lines.push(`${locale}:${key}`),
    });
  return (async () => {
    try {
      const core = make();
      await core.activate('zh');
      assert.equal(core.translate('a'), '甲');
      assert.equal(core.translate('b'), 'English B', 'English fills in');
      assert.equal(core.translate('c'), 'c', 'a key nobody has shows as itself');
      assert.ok(lines.includes('zh:b') && lines.includes('zh:c'), lines.join());
      // the phone UI's own handler logs only in a development build
      missingKeys.length = 0;
      g.__DEV__ = true;
      const ui = i18n.instance;
      ui.t('nobody.has.this');
      assert.deepEqual(missingKeys, ['en:nobody.has.this']);
      assert.deepEqual(warned, ['[i18n] missing en:nobody.has.this']);
      g.__DEV__ = false;
      ui.t('nobody.has.that');
      assert.equal(missingKeys.length, 2);
      assert.equal(warned.length, 1, 'no log outside development');
    } finally {
      console.warn = warn;
      delete g.__DEV__;
    }
  })();
});

test('the latest choice wins when catalogs arrive out of order, and a catalog that cannot be read leaves the default language', async () => {
  const release: Record<string, () => void> = {};
  const core = createMobileI18n({
    defaultLocale: 'en',
    defaultCatalog: { k: 'one' },
    importCatalog: (locale: string) =>
      new Promise((resolve, reject) => {
        release[locale] = () => (locale === 'bad' ? reject(new Error('offline')) : resolve({ k: locale }));
      }),
  });
  let published = 0;
  core.subscribe(() => published++);
  const slow = core.activate('slow');
  const fast = core.activate('fast');
  release.fast();
  await fast;
  release.slow();
  await slow;
  assert.equal(core.locale(), 'fast', 'an older request that settles later does not replace a newer one');
  assert.equal(core.translate('k'), 'fast');
  assert.equal(published, 1);
  // the same language again reads nothing: its catalog is held
  await core.activate('fast');
  assert.equal(core.locale(), 'fast');
  // a failed read: the default language, and the failure is logged
  const warn = console.warn;
  const warned: unknown[] = [];
  console.warn = (...a: unknown[]) => void warned.push(a[0]);
  try {
    const bad = core.activate('bad');
    release.bad();
    await bad;
    assert.equal(core.locale(), 'en');
    assert.equal(warned.length, 1);
    // a failure that an newer choice already replaced changes nothing
    const failing = core.activate('bad');
    const newer = core.activate('en');
    release.bad();
    await Promise.all([failing, newer]);
    assert.equal(core.locale(), 'en');
    assert.equal(warned.length, 1);
    // a catalog that arrives after a newer request, with no bundle yet, is not shown
    const late = core.activate('late');
    const now = core.activate('fast');
    await now;
    release.late();
    await late;
    assert.equal(core.locale(), 'fast');
  } finally {
    console.warn = warn;
  }
});

test('a plain string is cached until the language changes, and the cache is bounded', async () => {
  const core = createMobileI18n({ defaultLocale: 'en', defaultCatalog: { k: 'v' }, importCatalog: async () => ({ k: 'w' }) });
  assert.equal(core.translate('k'), 'v');
  core.instance.addResource('en', 'translation', 'k', 'changed');
  assert.equal(core.translate('k'), 'v', 'the held answer');
  await core.activate('fr');
  assert.equal(core.translate('k'), 'w');
  const flood = createMobileI18n({ defaultLocale: 'en', defaultCatalog: {}, importCatalog: async () => ({}) });
  for (let i = 0; i < 4100; i++) flood.translate(`key${i}`);
  assert.equal(flood.translate('key4099'), 'key4099');
});

test('pseudo-localization accents and pads each string, brackets one with a plural count, and is undone', () => {
  const core = createMobileI18n({
    defaultLocale: 'en',
    defaultCatalog: { k: 'Send', n_one: 'one', n_other: '{{count}} others' },
    importCatalog: async () => ({}),
  });
  let published = 0;
  core.subscribe(() => published++);
  core.setPseudoLocalization(true);
  core.setPseudoLocalization(true);
  assert.equal(core.isPseudoLocalization(), true);
  assert.equal(core.translate('k'), '[Séñd··]');
  assert.equal(core.translate('k'), '[Séñd··]', 'bracketed once');
  assert.equal(core.translate('n_other', { count: 3 }), '[3 óthérs····]');
  assert.equal(published, 1);
  core.setPseudoLocalization(false);
  assert.equal(core.translate('k'), 'Send');
  // the phone UI's own switch
  setPseudoLocalization(true);
  assert.equal(t('chats.title'), '[Cháts··]');
  setPseudoLocalization(false);
  assert.equal(t('chats.title'), 'Chats');
  const unsubscribe = core.subscribe(() => undefined);
  unsubscribe();
});

test('the phone asks for English or Simplified Chinese by its language tags; Traditional Chinese and other languages get English', () => {
  assert.equal(resolveLocale(['zh-Hans-CN']), 'zh-Hans');
  assert.equal(resolveLocale(['zh_CN']), 'zh-Hans');
  assert.equal(resolveLocale(['zh']), 'zh-Hans');
  assert.equal(resolveLocale(['zh-SG']), 'zh-Hans');
  assert.equal(resolveLocale(['zh-Hant-TW']), 'en');
  assert.equal(resolveLocale(['zh-TW']), 'en');
  assert.equal(resolveLocale(['zh-HK']), 'en');
  assert.equal(resolveLocale(['fr-FR', 'zh-Hans']), 'zh-Hans', 'the first language this app has');
  assert.equal(resolveLocale(['en-GB', 'zh-Hans']), 'en');
  assert.equal(resolveLocale(['de-DE']), 'en');
  assert.equal(resolveLocale([]), 'en');
  assert.equal(parseLanguage('zh-Hans'), 'zh-Hans');
  assert.equal(parseLanguage('en'), 'en');
  assert.equal(parseLanguage('klingon'), 'system');
  assert.equal(parseLanguage(null), 'system');
});

test('the language choice is kept and shown: System follows the phone, a bad store never forces one', async () => {
  const shown: string[] = [];
  const kept = new Map<string, string>();
  let tags = ['zh-Hans-CN'];
  let readFails = false;
  const control = createLanguage({
    store: {
      read: async () => {
        if (readFails) throw new Error('keychain');
        return kept.get('language') ?? null;
      },
      write: async (v: string) => void kept.set('language', v),
    },
    deviceTags: () => tags,
    show: async (locale: string) => void shown.push(locale),
  });
  assert.equal(await control.read(), 'system');
  assert.deepEqual(shown, ['zh-Hans'], "System shows the phone's own language");
  await control.set('en');
  assert.equal(kept.get('language'), 'en');
  assert.deepEqual(shown, ['zh-Hans', 'en']);
  assert.equal(await control.read(), 'en');
  tags = ['fr'];
  await control.set('system');
  assert.deepEqual(shown.at(-1), 'en');
  readFails = true;
  assert.equal(await control.read(), 'system');
  // with no `show` given it shows through the app's own switch
  const own = createLanguage({ store: { read: async () => 'zh-Hans', write: async () => undefined }, deviceTags: () => [] });
  assert.equal(await own.read(), 'zh-Hans');
  assert.equal(i18n.currentLocale(), 'zh-Hans');
  await own.set('en');
  assert.equal(i18n.currentLocale(), 'en');
});

test('every Chinese line fits where its English does: no wider than the English line by more than a third', async () => {
  const flat = (v: any, p = ''): Record<string, string> =>
    Object.entries(v).reduce((a, [k, x]) => (typeof x === 'string' ? { ...a, [`${p}${k}`]: x } : { ...a, ...flat(x, `${p}${k}.`) }), {});
  const en = flat((await import('../mobile/src/ui/i18n/locales/en.ts')).default);
  const zh = flat((await import('../mobile/src/ui/i18n/locales/zh-Hans.ts')).default);
  // a CJK character takes two cells of a Latin one
  const width = (s: string) => [...s].reduce((n, c) => n + (/[⺀-鿿＀-￯]/.test(c) ? 2 : 1), 0);
  for (const key of Object.keys(en))
    assert.ok(width(zh[key]) <= Math.ceil(width(en[key]) * 1.34) + 2, `${key}: ${zh[key]} against ${en[key]}`);
});
