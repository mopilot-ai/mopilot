// Every pressable in the phone app has a handler, and a row that goes dead says why (a detail line, no chevron, or an in-flight action).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from '../mobile/node_modules/typescript/lib/typescript.js';

const SRC = path.resolve(import.meta.dirname, '../mobile/src');
/** Components whose whole purpose is to be pressed. GroupItem is also a read-only info row, so it is checked only when it can turn dead. */
const MUST_HANDLE = new Set(['Pressable', 'Tap', 'TouchableOpacity', 'Button', 'ComposerButton', 'Chip', 'IconButton', 'Switch']);
const HANDLERS = ['onPress', 'onValueChange', 'onLongPress'];
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.tsx') ? [path.join(dir, e.name)] : [],
  );

function problems(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = node.tagName.getText();
      const attrs = node.attributes.properties;
      const spread = attrs.some((a) => !ts.isJsxAttribute(a));
      const named = (name: string) => attrs.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText() === name);
      const handler = attrs.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && HANDLERS.includes(a.name.getText()));
      const expr = handler?.initializer && ts.isJsxExpression(handler.initializer) ? handler.initializer.expression?.getText() : undefined;
      const where = `${path.relative(SRC, file)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} <${tag}>`;
      if (MUST_HANDLE.has(tag) && !handler && !spread) found.push(`${where} has no handler`);
      if (MUST_HANDLE.has(tag) && expr === 'undefined') found.push(`${where} has a handler that is always undefined`);
      if (tag === 'GroupItem' && expr && /\bundefined\b/.test(expr) && !/\bbusy\b/.test(expr) && !named('detail') && !named('end')) {
        found.push(`${where} can go dead with no visible reason (add detail, drop the chevron, or gate on busy)`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

test('every pressable in the phone app has a handler and no row goes dead silently', () => {
  const all = walk(SRC).flatMap((f) => problems(f, readFileSync(f, 'utf8')));
  assert.deepEqual(all, []);
});

test('the checker flags a missing handler, a dead handler and a silent dead row', () => {
  const bad = `const a = <Pressable style={s} />; const b = <Button title="x" onPress={undefined} />; const c = <GroupItem title="t" onPress={full ? undefined : go} />;`;
  assert.equal(problems('x.tsx', bad).length, 3);
  const ok = `const a = <Pressable onPress={go} />; const b = <Button {...props} />; const c = <GroupItem title="t" detail="Full" onPress={full ? undefined : go} />; const d = <GroupItem title="t" onPress={busy ? undefined : go} />; const e = <GroupItem title="t" />; const f = <Switch onValueChange={set} />;`;
  assert.deepEqual(problems('y.tsx', ok), []);
});
