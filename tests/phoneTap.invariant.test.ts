// Every tappable of the phone is a Tap: a bare React Native pressable or touchable draws its press look through JS, which waits for a busy thread, while Tap's is the native button's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from '../mobile/node_modules/typescript/lib/typescript.js';

const MOBILE = path.resolve(import.meta.dirname, '../mobile');
/** The one file that may use the platform's pressables. */
const PRIMITIVE = 'src/ui/ds/Tap.tsx';
const BANNED = new Set(['Pressable', 'TouchableOpacity', 'TouchableHighlight', 'TouchableWithoutFeedback', 'TouchableNativeFeedback']);
const BUTTONS = new Set(['Touchable', 'RectButton', 'BaseButton', 'BorderlessButton', 'LegacyPressable', 'Pressable']);
const SKIP = new Set(['node_modules', 'ios', 'android', '.expo', 'dist', 'build', 'modules']);

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (SKIP.has(e.name) ? [] : walk(path.join(dir, e.name))) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : [],
  );

/** The platform pressables a source file imports, as readable lines. */
export function barePressables(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  for (const node of sf.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const from = node.moduleSpecifier.text;
    const named = node.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    const banned = from === 'react-native' ? BANNED : from === 'react-native-gesture-handler' ? BUTTONS : undefined;
    for (const el of named.elements)
      if (banned?.has((el.propertyName ?? el.name).text))
        found.push(`${file} imports ${(el.propertyName ?? el.name).text} from ${from}: use Tap`);
  }
  return found;
}

test('no phone file draws a press with a bare React Native or gesture-handler button, except Tap itself', () => {
  const files = [...walk(path.join(MOBILE, 'src')), ...walk(path.join(MOBILE, 'vendor')), path.join(MOBILE, 'App.tsx')];
  const bad = files
    .map((f) => path.relative(MOBILE, f))
    .filter((f) => f !== PRIMITIVE)
    .flatMap((f) => barePressables(f, readFileSync(path.join(MOBILE, f), 'utf8')));
  assert.deepEqual(bad, []);
});

test('the primitive is where the platform buttons are used', () => {
  assert.deepEqual(barePressables(PRIMITIVE, readFileSync(path.join(MOBILE, PRIMITIVE), 'utf8')).length, 2);
});

test('the checker flags each platform pressable, aliases included, and lets Tap and ordinary imports through', () => {
  const bad = `import { Pressable as P, Text } from 'react-native'; import { RectButton, GestureDetector } from 'react-native-gesture-handler'; import { TouchableOpacity } from 'react-native';`;
  assert.equal(barePressables('x.tsx', bad).length, 3);
  const ok = `import { Text, View } from 'react-native'; import { GestureDetector } from 'react-native-gesture-handler'; import { Tap } from './Tap'; import Default from 'react-native'; import * as RN from 'react-native'; import 'react-native'; import type { Pressable } from './elsewhere';`;
  assert.deepEqual(barePressables('y.tsx', ok), []);
});
