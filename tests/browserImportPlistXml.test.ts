// XML property list parser used for Safari's Bookmarks.plist: every value type, entities, and malformed documents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parsePlistXml } = require('../electron/capabilities/browser/import/plistXml.cjs');

const doc = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${body}\n</plist>\n`;
const failed = (why: RegExp) => (e: any) => e.name === 'ImportError' && e.code === 'read_failed' && why.test(e.message);

test('parsePlistXml: every value type, nested, with entities, comments and empty elements', () => {
  const out = parsePlistXml(
    doc(`<dict>
  <!-- a comment <string>ignored</string> -->
  <key>s</key><string>a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#233; &#x1F600;</string>
  <key>empty</key><string/>
  <key>int</key><integer>-42</integer>
  <key>real</key><real> 1.5 </real>
  <key>yes</key><true/>
  <key>no</key><false/>
  <key>when</key><date>2026-01-02T03:04:05Z</date>
  <key>bad date</key><date>not a date</date>
  <key>bytes</key><data>
    AAEC
    Aw==
  </data>
  <key>list</key><array><string>x</string><dict/><array/><integer>1</integer></array>
  <key>nested</key><dict><key>k&amp;</key><dict><key>deep</key><true/></dict></dict>
  <key/><string>blank key</string>
</dict>`),
  );
  assert.equal(Object.getPrototypeOf(out), null);
  assert.equal(out.s, 'a & b <c> "d" \'e\' é 😀');
  assert.equal(out.empty, '');
  assert.equal(out.int, -42);
  assert.equal(out.real, 1.5);
  assert.equal(out.yes, true);
  assert.equal(out.no, false);
  assert.equal(out.when, Date.UTC(2026, 0, 2, 3, 4, 5));
  assert.equal(out['bad date'], null);
  assert.deepEqual([...out.bytes], [0, 1, 2, 3]);
  assert.equal(out.list.length, 4);
  assert.equal(out.list[0], 'x');
  assert.deepEqual(Object.keys(out.list[1]), []);
  assert.deepEqual(out.list[2], []);
  assert.equal(out.list[3], 1);
  assert.equal(out.nested['k&'].deep, true);
  assert.equal(out[''], 'blank key');
});

test('parsePlistXml: a __proto__ key is an ordinary entry, and parsing twice starts fresh', () => {
  const xml = doc('<dict><key>__proto__</key><dict><key>polluted</key><true/></dict></dict>');
  const out = parsePlistXml(xml);
  assert.equal(out.__proto__.polluted, true);
  assert.equal(({} as any).polluted, undefined);
  assert.equal(parsePlistXml(xml).__proto__.polluted, true);
});

test('parsePlistXml: root values other than a dictionary', () => {
  assert.equal(parsePlistXml(doc('<string>only</string>')), 'only');
  assert.deepEqual(parsePlistXml(doc('<array/>')), []);
  assert.equal(parsePlistXml('<plist></plist>'), undefined);
});

test('parsePlistXml: malformed documents are a failed read', () => {
  const cases: [string, RegExp][] = [
    ['', /incomplete/],
    ['<plist><dict>', /incomplete/],
    ['<plist><string>open', /incomplete/],
    ['<plist></plist><string>after', /incomplete/],
    ['<string>x</string>', /outside the document/],
    ['<plist/>', /outside the document/],
    ['<plist><dict><string>x</string></dict></plist>', /without a key/],
    ['<plist><true/><false/></plist>', /more than one root/],
    ['<plist><string><dict></string></plist>', /<dict> inside <string>/],
    ['<plist><string>x</key></plist>', /<key> inside <string>/],
    ['</dict>', /unmatched <\/dict>/],
    ['<plist><dict></array></plist>', /unmatched <\/array>/],
    ['<plist><dict><key>a</key></dict></plist>', /key without a value/],
    ['<key>a</key>', /key outside a dictionary/],
    ['<plist><array><key>a</key></array></plist>', /key outside a dictionary/],
    ['<plist><dict><key>a</key><key>b</key></dict></plist>', /key outside a dictionary/],
    ['<plist><blob/></plist>', /unknown <blob>/],
    ['<plist><string>&#1114112;</string></plist>', /invalid character reference &#1114112;/],
    ['<plist><string>&#x110000;</string></plist>', /invalid character reference &#x110000;/],
  ];
  for (const [xml, why] of cases) assert.throws(() => parsePlistXml(xml), failed(why), xml);
});
