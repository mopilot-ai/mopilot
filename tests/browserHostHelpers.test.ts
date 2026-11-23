// The browser host helpers (electron/capabilities/browser/hostUtil.cjs and keys.cjs): URL redaction and
// normalization, modifier bits and key chords, download paths, one-line text and blank images.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, redactUrl, chord, modifierBits, safeFileName, oneLine, isBlank, image } from './support/browser-host-kit.ts';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

test('redactUrl hides credential-like query values and userinfo; non-URLs pass through as text', () => {
  assert.equal(
    redactUrl('https://u:p@a.test/x?token=1&q=2&api_key=3&Session=4&codec=5'),
    'https://a.test/x?token=REDACTED&q=2&api_key=REDACTED&Session=REDACTED&codec=REDACTED',
  );
  assert.equal(redactUrl('https://a.test/p?page=2'), 'https://a.test/p?page=2');
  // the hand-off's rule too: a one-time link's parameters and a token as a value, whatever its name
  assert.equal(
    redactUrl('https://a.test/x?verify=1&oauth_verifier=2&d=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln'),
    'https://a.test/x?verify=REDACTED&oauth_verifier=REDACTED&d=REDACTED',
  );
  assert.equal(redactUrl('https://user@a.test/'), 'https://a.test/');
  assert.equal(redactUrl('not a url'), 'not a url');
  assert.equal(redactUrl(42), '42');
});

test('inherited object names are unknown browser modifiers and keys', () => {
  for (const name of Object.getOwnPropertyNames(Object.prototype)) {
    assert.throws(() => modifierBits(name), { code: 'bad_args' }, name);
    assert.throws(() => chord(name), { code: 'bad_args' }, name);
  }
});

test('modifierBits maps names to CDP bits and refuses unknown ones', () => {
  assert.equal(modifierBits('ctrl+shift'), 10);
  assert.equal(modifierBits(' Cmd + Alt '), 5);
  assert.equal(modifierBits('option+control+meta+super+win+windows+command'), 7);
  assert.equal(modifierBits(''), 0);
  assert.equal(modifierBits(undefined), 0);
  assert.throws(() => modifierBits('hyper'), { code: 'bad_args', message: 'Unknown modifier: hyper' });
});

test('chord: named keys, letters, digits, symbols and macOS editing commands as CDP key events', () => {
  assert.deepEqual(chord('Enter', 'linux'), {
    down: {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      modifiers: 0,
      text: '\r',
      unmodifiedText: '\r',
    },
    up: { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 0 },
  });
  assert.equal(chord('Tab', 'linux').down.type, 'rawKeyDown');
  assert.equal(chord('Tab', 'linux').down.text, undefined);
  assert.deepEqual(chord('a', 'linux').down, {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 0,
    text: 'a',
    unmodifiedText: 'a',
  });
  const shiftA = chord('shift+a', 'linux').down;
  assert.equal(shiftA.key, 'A');
  assert.equal(shiftA.text, 'A');
  assert.equal(shiftA.modifiers, 8);
  const ctrlA = chord('ctrl+a', 'linux').down;
  assert.equal(ctrlA.type, 'rawKeyDown');
  assert.equal(ctrlA.text, undefined);
  assert.equal(ctrlA.commands, undefined);
  assert.deepEqual(chord('cmd+a', 'darwin').down.commands, ['selectAll']);
  assert.deepEqual(chord('cmd+shift+z', 'darwin').down.commands, ['redo']);
  assert.deepEqual(chord('cmd+z', 'darwin').down.commands, ['undo']);
  assert.equal(chord('cmd+q', 'darwin').down.commands, undefined);
  assert.equal(chord('cmd+a', 'linux').down.commands, undefined);
  assert.equal(chord('ctrl+a', 'darwin').down.commands, undefined);
  assert.deepEqual([chord('5', 'linux').down.code, chord('5', 'linux').down.windowsVirtualKeyCode], ['Digit5', 53]);
  assert.deepEqual(
    [chord('/', 'linux').down.code, chord('/', 'linux').down.windowsVirtualKeyCode, chord('/', 'linux').down.text],
    ['', 47, '/'],
  );
  assert.deepEqual([chord('+', 'linux').down.key, chord('+', 'linux').down.modifiers], ['+', 0]);
  assert.deepEqual([chord('ctrl++', 'linux').down.key, chord('ctrl++', 'linux').down.modifiers], ['+', 2]);
  assert.deepEqual([chord('F5', 'linux').down.key, chord('F5', 'linux').down.windowsVirtualKeyCode], ['F5', 116]);
  assert.equal(chord('Space', 'linux').down.text, ' ');
  assert.equal(chord('a').down.key, 'a', 'the platform defaults to this process');
  assert.throws(() => chord('nope', 'linux'), { code: 'bad_args', message: 'Unknown key: nope' });
  assert.throws(() => chord('foo+a', 'linux'), { code: 'bad_args' });
});

test('normalizeUrl: https by default, http for local servers, only http(s) and about:blank', () => {
  assert.equal(normalizeUrl('  about:blank '), 'about:blank');
  assert.equal(normalizeUrl('localhost:3000/x'), 'http://localhost:3000/x');
  assert.equal(normalizeUrl('127.0.0.1'), 'http://127.0.0.1/');
  assert.equal(normalizeUrl('[::1]:8080?q=1'), 'http://[::1]:8080/?q=1');
  assert.equal(normalizeUrl('example.com/a'), 'https://example.com/a');
  assert.equal(normalizeUrl('HTTP://Example.com'), 'http://example.com/');
  assert.throws(() => normalizeUrl(''), { code: 'bad_args' });
  assert.throws(() => normalizeUrl(null), { code: 'bad_args' });
  assert.throws(() => normalizeUrl('ftp://x.test/f'), { code: 'bad_url', message: /^Only http and https pages can be opened/ });
  assert.throws(() => normalizeUrl('https://'), { code: 'bad_url', message: /^Not a valid URL/ });
});

test('safeFileName turns separators and NUL into _, caps the length and falls back to "download"', () => {
  assert.equal(safeFileName('a/b:c\\d\u0000.txt'), 'a_b_c_d_.txt');
  assert.equal(safeFileName(''), 'download');
  assert.equal(safeFileName(null), 'download');
  assert.equal(safeFileName([] as any), 'download', 'a name that stringifies to nothing');
  assert.equal(safeFileName('x'.repeat(300)).length, 200);
});

test('oneLine collapses control characters and caps the length', () => {
  assert.equal(oneLine(null), '');
  assert.equal(oneLine(' a\nb c\t '), 'a b c');
  assert.equal(oneLine('x'.repeat(10), 5), 'xxxx…');
  assert.equal(oneLine('x'.repeat(200)), 'x'.repeat(200));
});

test('isBlank: nothing, an empty image, or only black or transparent pixels', () => {
  assert.equal(isBlank(null), true);
  assert.equal(isBlank(image({}, true)), true);
  assert.equal(isBlank(image({}, false, true)), true);
  assert.equal(isBlank({ isEmpty: () => false, toBitmap: () => Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]) }), true, 'transparent');
  assert.equal(isBlank(image({})), false);
  for (const px of [
    [9, 0, 0, 255],
    [0, 9, 0, 255],
    [0, 0, 9, 255],
  ])
    assert.equal(isBlank({ isEmpty: () => false, toBitmap: () => Buffer.from(px) }), false);
});
