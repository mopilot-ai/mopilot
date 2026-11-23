// The phone UI's words live in two catalogs that stay in step (every key in both, the same placeholders), name no one but MoPilot, are short, and no phone UI file shows a literal that is not a key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import enCatalog from '../mobile/src/ui/i18n/locales/en.ts';
import zhCatalog from '../mobile/src/ui/i18n/locales/zh-Hans.ts';
import { posix } from 'node:path';
import { uiLiterals } from './support/phone/uiLiterals.ts';
import { walk } from './phoneVendorGuard.invariant.test.ts';

const flatten = (value: any, prefix = ''): Record<string, string> =>
  Object.entries(value).reduce(
    (all, [key, v]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return typeof v === 'string' ? { ...all, [path]: v } : { ...all, ...flatten(v, path) };
    },
    {} as Record<string, string>,
  );
const en = flatten(enCatalog);
const zh = flatten(zhCatalog);
const placeholders = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();

test('every key is in both catalogs, with the same placeholders', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const key of Object.keys(en)) assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), key);
});

test('a plural key has its one and other forms together', () => {
  const families = new Set(
    Object.keys(en)
      .filter((k) => /_(one|other)$/.test(k))
      .map((k) => k.replace(/_(one|other)$/, '')),
  );
  for (const family of families) {
    assert.ok(`${family}_one` in en && `${family}_other` in en, family);
    assert.ok(`${family}_one` in zh && `${family}_other` in zh, family);
  }
});

test('no line names the product Orca was copied from, and no value is empty or a long sentence', () => {
  for (const [name, catalog] of [
    ['en', en],
    ['zh-Hans', zh],
  ] as const) {
    for (const [key, text] of Object.entries(catalog)) {
      assert.ok(text.trim().length > 0, `${name}:${key} is empty`);
      assert.ok(!/orca/i.test(text) && !/orca/i.test(key), `${name}:${key} names Orca`);
      assert.ok(text.length <= 90, `${name}:${key} is ${text.length} characters`);
    }
  }
});

test('no phone UI file shows a literal that is not a catalog key', () => {
  const files = walk('mobile/src/ui').filter((f) => /\.tsx$/.test(f) && !f.startsWith('mobile/src/ui/i18n/'));
  const bad = files.flatMap((f) => uiLiterals(readFileSync(f, 'utf8')).map((text) => `${posix.basename(f)}: ${text}`));
  assert.deepEqual(bad, []);
});

test('the literal scan finds shown text, string children and text props, and leaves comments, identifiers and expressions', () => {
  const source = `// Hello there
    /* A block comment */
    <Text accessibilityLabel="Send message" testID="send-button" style={{ color: 'red' }}>Send</Text>
    <Text>{t('chat.stop')}</Text>
    <Pressable label='Stop' placeholder={'Type here'} />
    <Text>  </Text><Text>123</Text><Text>发送</Text>
    <Text>{busy ? 'Sending' : 'Send'}{ok && 'Done'}{name ?? 'Nobody'}{'Plain'}{(\`Hello \${who}\`)}</Text>
    <>Fragment words</>`;
  assert.deepEqual(uiLiterals(source), [
    'Send message',
    'Send',
    'Stop',
    'Type here',
    '发送',
    'Sending',
    'Send',
    'Done',
    'Nobody',
    'Plain',
    'Hello',
    'Fragment words',
  ]);
});

test('the literal scan is not fooled by types, arrow returns, comparisons and generics (R2 Pressable.tsx, `): StyleProp`)', () => {
  const source = `export function Press({ style }: { style?: StyleProp<ViewStyle> }) {
    const resolved = ({ pressed }: { pressed: boolean }): StyleProp<ViewStyle> => [style, pressed && { opacity: 0.6 }];
    const wide = width > 320 && height < 640 ? 'a' : 'b';
    const list = useState<string[]>([]);
    return <Pressable style={resolved} onPress={go} key="row" testID="press">{children}</Pressable>;
  }`;
  assert.deepEqual(uiLiterals(source), []);
});

test('the literal scan still catches the words it must: a child, a label, a choice of two', () => {
  assert.deepEqual(uiLiterals('const a = <Text style={s}>Delete chat</Text>;'), ['Delete chat']);
  assert.deepEqual(uiLiterals('const a = <Pressable accessibilityLabel="Close" onPress={go} />;'), ['Close']);
  assert.deepEqual(uiLiterals("const a = <Text>{failed ? 'Not sent.' : 'Sent'}</Text>;"), ['Not sent.', 'Sent']);
});
