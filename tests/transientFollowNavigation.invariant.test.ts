// Viewport setup must not click an auto-follow control after a visibility snapshot that can become stale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'vite';
import { treeFiles } from '../scripts/source-tree.mjs';

export const GUARDS = ['tests/e2e/'];

const text = (n: any) =>
  n?.type === 'Literal' ? n.value : n?.type === 'TemplateLiteral' && n.expressions.length === 0 ? n.quasis[0].value.cooked : undefined;
const member = (n: any) => (n?.computed ? text(n.property) : n?.property?.name);
const method = (n: any, name: string) => n?.type === 'CallExpression' && n.callee.type === 'MemberExpression' && member(n.callee) === name;
const appPage = (n: any) =>
  (n?.type === 'Identifier' && n.name === 'page') ||
  (n?.type === 'MemberExpression' && ['h', 'harness'].includes(n.object?.name) && member(n) === 'page');

function boundNames(pattern: any): string[] {
  if (!pattern) return [];
  if (pattern.type === 'Identifier') return [pattern.name];
  if (pattern.type === 'RestElement') return boundNames(pattern.argument);
  if (pattern.type === 'AssignmentPattern') return boundNames(pattern.left);
  if (pattern.type === 'ArrayPattern') return pattern.elements.flatMap(boundNames);
  if (pattern.type === 'ObjectPattern')
    return pattern.properties.flatMap((p: any) => boundNames(p.type === 'RestElement' ? p.argument : p.value));
  return [];
}

function walk(node: any, visit: (node: any) => void, skipFunctions = false) {
  if (!node || typeof node !== 'object') return;
  if (skipFunctions && ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((n) => walk(n, visit, skipFunctions));
    else if (value && typeof value === 'object') walk(value, visit, skipFunctions);
  }
}

/** Canonical local const locators and direct branch actions; aliases and nested control flow still need review. */
function staleFollowClicks(source: string, file = 'follow-spec.ts'): number[] {
  const parsed = parseSync(file, source);
  assert.deepEqual(parsed.errors, [], `Parse ${file}`);
  const found: number[] = [];
  walk(parsed.program, (node) => {
    if (!['BlockStatement', 'Program'].includes(node.type)) return;
    const follows = new Set<string>();
    for (const statement of node.body) {
      if (statement.type === 'VariableDeclaration' && statement.kind === 'const') {
        for (const decl of statement.declarations) {
          const name = decl.init?.arguments?.[1]?.properties?.find((p: any) => (p.key?.name ?? text(p.key)) === 'name')?.value;
          if (
            decl.id.type === 'Identifier' &&
            method(decl.init, 'getByRole') &&
            appPage(decl.init.callee.object) &&
            text(decl.init.arguments[0]) === 'button' &&
            text(name) === 'Scroll to bottom'
          )
            follows.add(decl.id.name);
        }
      }
      if (statement.type !== 'IfStatement') continue;
      const checked = new Set<string>();
      walk(
        statement.test,
        (n) => {
          if (method(n, 'isVisible') && follows.has(n.callee.object?.name)) checked.add(n.callee.object.name);
        },
        true,
      );
      const actions = statement.consequent.type === 'BlockStatement' ? statement.consequent.body : [statement.consequent];
      // Lexical declarations shadow the outer locator throughout this branch, including before their declaration.
      for (const action of actions) {
        if (action.type === 'VariableDeclaration')
          for (const decl of action.declarations) for (const name of boundNames(decl.id)) checked.delete(name);
        if (['FunctionDeclaration', 'ClassDeclaration'].includes(action.type)) checked.delete(action.id?.name);
      }
      for (const action of actions)
        if (action.type === 'ExpressionStatement')
          walk(
            action.expression,
            (n) => {
              if (method(n, 'click') && checked.has(n.callee.object?.name)) found.push(n.start);
            },
            true,
          );
    }
  });
  return found;
}

test('the follow guard rejects visibility-then-click but preserves direct control tests and target navigation', () => {
  const binding = "const follow = page.getByRole('button', { name: 'Scroll to bottom', exact: true });\n";
  for (const action of [
    'if (await follow.isVisible()) await follow.click();',
    "if (await follow['isVisible']()) { await follow['click'](); }",
  ])
    assert.equal(staleFollowClicks(binding + action).length, 1);
  for (const action of [
    'await follow.click();',
    'await target.scrollIntoViewIfNeeded();',
    'if (await follow.isVisible()) await expect(target).toBeInViewport();',
    '// if (await follow.isVisible()) await follow.click();',
  ])
    assert.deepEqual(staleFollowClicks(binding + action), []);
  assert.deepEqual(
    staleFollowClicks("const follow = page.getByRole('button', { name: 'Help' }); if (await follow.isVisible()) await follow.click();"),
    [],
  );
  assert.deepEqual(staleFollowClicks(binding + 'async function other(follow) { if (await follow.isVisible()) await follow.click(); }'), []);
  assert.equal(
    staleFollowClicks(
      "const bottom = harness.page.getByRole('button', { name: `Scroll to bottom` }); if (await bottom.isVisible()) await bottom.click();",
    ).length,
    1,
  );
  assert.deepEqual(
    staleFollowClicks(
      "const bottom = otherPage.getByRole('button', { name: 'Scroll to bottom' }); if (await bottom.isVisible()) await bottom.click();",
    ),
    [],
  );
  assert.deepEqual(
    staleFollowClicks(
      binding + "if (await follow.isVisible()) { const follow = page.getByRole('button', { name: 'Help' }); await follow.click(); }",
    ),
    [],
  );
  assert.deepEqual(
    staleFollowClicks(binding + 'if (await follow.isVisible()) { const { button: follow } = helpers; await follow.click(); }'),
    [],
  );
});

test('E2E viewport setup does not depend on a transient auto-follow button after an awaited visibility check', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const violations: string[] = [];
  for (const file of treeFiles(path.join(root, 'tests/e2e'), /\.[cm]?tsx?$/)) {
    const source = readFileSync(file, 'utf8');
    for (const offset of staleFollowClicks(source, file))
      violations.push(`${path.relative(root, file)}:${source.slice(0, offset).split('\n').length}`);
  }
  assert.deepEqual(
    violations,
    [],
    'Scroll the semantic target into view and assert its viewport position; auto-follow may remove its button between awaits.',
  );
});
