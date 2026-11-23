// A phone screen or sheet that has a way back (a `back`, `close` or `home` prop, or a modal overlay) must answer Android's back button as well, or the button closes the app from there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : /\.tsx$/.test(entry.name) ? [join(dir, entry.name)] : [],
  );
const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Native Modal routes Android hardware Back through onRequestClose instead of emitting BackHandler events. */
const nativeModalBack = (code: string) =>
  [...code.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*['"]react-native['"]/g)].some(([, names]) =>
    names.split(',').some((name) => name.trim() === 'Modal'),
  ) && /<Modal\b[^>]*\bonRequestClose\s*=\s*\{\s*(back|close|home)\s*\}/.test(code);

/** Source files with a way back that neither draw BackLink, ChatHeader, ScreenHeader or BottomSheet, nor call useChatHeader (which listen), nor call the hook with a callback. */
export function screensWithoutHardwareBack(sources: Record<string, string>): string[] {
  return Object.entries(sources)
    .map(([file, source]) => [file, withoutComments(source)] as const)
    .filter(([, code]) => /\b(back|close|home)\??: \(\) => void\b/.test(code) || /\baccessibilityViewIsModal\b/.test(code))
    .filter(
      ([, code]) =>
        !/<(BackLink|ChatHeader|ScreenHeader|BottomSheet)\b/.test(code) &&
        !nativeModalBack(code) &&
        !/\buseChatHeader\(/.test(code) &&
        !/\buseHardwareBack\([^)\s]/.test(code),
    )
    .map(([file]) => file);
}

test('every screen and sheet with a way back also answers the hardware back button', () => {
  const sources = Object.fromEntries(files('mobile/src').map((file) => [file, readFileSync(file, 'utf8')]));
  assert.deepEqual(screensWithoutHardwareBack(sources), []);
});

test('the scan names a screen with a way back and no listener, and passes one with a listener', () => {
  const bare = 'export function Screen({ back }: { back: () => void }) { return <Button onPress={back} />; }';
  assert.deepEqual(screensWithoutHardwareBack({ 'a.tsx': bare }), ['a.tsx']);
  assert.deepEqual(screensWithoutHardwareBack({ 'a.tsx': 'type P = {\n  close: () => void;\n  open?: boolean;\n};' }), ['a.tsx']);
  assert.deepEqual(screensWithoutHardwareBack({ 'a.tsx': 'type P = {\n  back?: () => void,\n};' }), ['a.tsx']);
  assert.deepEqual(screensWithoutHardwareBack({ 'a.tsx': '<View accessibilityViewIsModal />' }), ['a.tsx']);
  assert.deepEqual(screensWithoutHardwareBack({ 'a.tsx': 'type P = { home: () => void };' }), ['a.tsx']);
  assert.deepEqual(screensWithoutHardwareBack({ 'a.tsx': `${bare}\nuseHardwareBack(back);` }), []);
  assert.deepEqual(screensWithoutHardwareBack({ 'a.tsx': `${bare}\n<BackLink onPress={back} />` }), []);
  // a screen that draws its header from useChatHeader answers it through the hook
  assert.deepEqual(screensWithoutHardwareBack({ 'a.tsx': `${bare}\nconst header = useChatHeader({ back });` }), []);
  // a sheet drawn in a BottomSheet answers the back button through it
  assert.deepEqual(screensWithoutHardwareBack({ 'a.tsx': `${bare}\n<BottomSheet open onClose={back} />` }), []);
  assert.deepEqual(screensWithoutHardwareBack({ 'a.tsx': 'const x = 1;' }), []);
});

test('a listener that is only mentioned in a comment or called with nothing does not count', () => {
  const bare = 'export function Screen({ back }: { back: () => void }) {}';
  assert.deepEqual(screensWithoutHardwareBack({ 'a.tsx': `${bare}\n// useHardwareBack(back);` }), ['a.tsx']);
  assert.deepEqual(screensWithoutHardwareBack({ 'a.tsx': `${bare}\n/* useHardwareBack(back) */` }), ['a.tsx']);
  assert.deepEqual(screensWithoutHardwareBack({ 'a.tsx': `${bare}\nuseHardwareBack();` }), ['a.tsx']);
});

test('native Modal hardware Back uses the real close callback; an absent or unrelated callback still fails', () => {
  const props = 'type Props = { close: () => void };';
  const imported = "import { Image, Modal, View } from 'react-native';";
  const native = `${imported}${props}<Modal visible onRequestClose={close} />`;
  assert.deepEqual(screensWithoutHardwareBack({ 'viewer.tsx': native }), []);
  for (const callback of ['', 'onRequestClose={undefined}', 'onRequestClose={null}', 'onRequestClose={ignore}']) {
    assert.deepEqual(screensWithoutHardwareBack({ 'viewer.tsx': `${imported}${props}<Modal ${callback} />` }), ['viewer.tsx']);
  }
  assert.deepEqual(screensWithoutHardwareBack({ 'viewer.tsx': `${props}<View onRequestClose={close} />` }), ['viewer.tsx']);
  assert.deepEqual(screensWithoutHardwareBack({ 'viewer.tsx': native.replace("'react-native'", "'unrelated'") }), ['viewer.tsx']);
  assert.deepEqual(screensWithoutHardwareBack({ 'viewer.tsx': native.replace('Image, Modal, View', 'Modal as OtherModal') }), [
    'viewer.tsx',
  ]);
});

test('aliasing another export to Modal or importing Modal as a type cannot bypass hardware-back protection', () => {
  for (const specifier of ['View as Modal', 'type Modal']) {
    const source = `import { ${specifier} } from 'react-native'; type Props = { close: () => void }; <Modal onRequestClose={close} />`;
    assert.deepEqual(screensWithoutHardwareBack({ 'viewer.tsx': source }), ['viewer.tsx']);
  }
});
