// E2E app-chrome navigation must not target retired Home buttons or the hidden Other harnesses sidebar row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseSync } from 'vite';
import { treeFiles } from '../scripts/source-tree.mjs';
import { invariantTestsFor } from '../scripts/related-tests.mjs';

export const GUARDS = ['src/', 'tests/e2e/'];

const root = fileURLToPath(new URL('../', import.meta.url));

function text(node: any): string | undefined {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
}

const memberName = (node: any) => (node?.computed ? text(node.property) : node?.property?.name);
const call = (node: any, name: string) =>
  node?.type === 'CallExpression' && node.callee.type === 'MemberExpression' && memberName(node.callee) === name;
const appPage = (node: any) =>
  (node?.type === 'Identifier' && node.name === 'page') ||
  (node?.type === 'MemberExpression' && ['h', 'harness'].includes(node.object?.name) && memberName(node) === 'page');

/** Only app-root or explicit app-sidebar queries: content and other browser pages may legitimately have Home buttons. */
function appChrome(node: any): boolean {
  if (appPage(node)) return true;
  if (call(node, 'getByRole') && text(node.arguments[0]) === 'complementary') return appPage(node.callee.object);
  return (
    call(node, 'locator') &&
    ['.sidebar', '.thread-sidebar', '.settings-nav', '.plugins-nav'].includes(text(node.arguments[0]) ?? '') &&
    appPage(node.callee.object)
  );
}

/** A precise mechanical guard, not alias analysis: dynamic names and arbitrary page aliases still need review. */
function retiredNavigationLocators(source: string, file = 'navigation-spec.ts'): number[] {
  const parsed = parseSync(file, source);
  assert.deepEqual(parsed.errors, [], `Could not parse ${file}`);
  const found: number[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (call(node, 'getByRole') && appChrome(node.callee.object) && text(node.arguments[0]) === 'button') {
      const options = node.arguments[1];
      const name = options?.properties?.find((p: any) => p.type === 'Property' && (p.key.name ?? text(p.key)) === 'name')?.value;
      if (text(name) === 'Home' || (name?.regex && /^\^?Home\$?$/i.test(name.regex.pattern))) found.push(node.start);
    }
    const filtered = call(node, 'filter');
    const locator = filtered ? node.callee.object : node;
    if (call(locator, 'locator') && appChrome(locator.callee.object) && /\.side-row\b/.test(text(locator.arguments[0]) ?? '')) {
      const hasText = node.arguments[filtered ? 0 : 1]?.properties?.find(
        (p: any) => p.type === 'Property' && (p.key.name ?? text(p.key)) === 'hasText',
      )?.value;
      // the hidden row by its label, old or new (Other harnesses became Other agents, #3518)
      if (['Other harnesses', 'Other agents'].includes(text(hasText) ?? '')) found.push(node.start);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  };
  walk(parsed.program);
  return found;
}

test('retired navigation guard catches app-root and sidebar Home buttons across locator spelling and chaining', () => {
  for (const source of [
    `page.getByRole('button', { name: 'Home' }).click()`,
    `page.getByRole('button', { name: 'Home' }).first().click()`,
    `page.getByRole(\n 'button', { exact: true, name: "Home" },\n).click()`,
    'page.getByRole(`button`, { name: `Home` })',
    `page['getByRole']('button', { 'name': 'Home' })`,
    `page.getByRole('button', { name: /^Home$/ })`,
    `page.getByRole('button', { name: /home/i })`,
    `page.getByRole('complementary').getByRole('button', { name: 'Home' })`,
    `page.locator('.settings-nav').getByRole('button', { name: 'Home' })`,
    `harness.page.getByRole('button', { name: 'Home' })`,
    `h.page.getByRole('button', { name: 'Home' })`,
  ])
    assert.equal(retiredNavigationLocators(source).length, 1, source);
});

test('retired navigation guard preserves Home content, browser pages and the current navigation controls', () => {
  for (const source of [
    `page.getByRole('heading', { name: 'Home' })`,
    `page.getByText('Home')`,
    `page.getByRole('button', { name: 'Home directory' })`,
    `page.getByRole('button', { name: /^Home directory$/ })`,
    `page.getByRole('button', { name: 'Back to app', exact: true })`,
    `standaloneNewChat(page).click()`,
    `page.getByRole('main').getByRole('button', { name: 'Home' })`,
    `page.locator('.plugin-row').getByRole('button', { name: 'Home' })`,
    `page.locator('.document').getByRole('button', { name: 'Home' })`,
    `browserPage.getByRole('button', { name: 'Home' })`,
    `browserPage.getByRole('complementary').getByRole('button', { name: 'Home' })`,
    `page.frameLocator('iframe').getByRole('button', { name: 'Home' })`,
    `// page.getByRole('button', { name: 'Home' })`,
    `const example = "page.getByRole('button', { name: 'Home' })"`,
  ])
    assert.deepEqual(retiredNavigationLocators(source), [], source);
});

test('retired settings navigation catches the hidden sidebar row while preserving page content and shared lookup', () => {
  for (const source of [
    `page.locator('.side-row', { hasText: 'Other harnesses' }).click()`,
    `page.locator('.settings-nav .side-row', { hasText: 'Other harnesses' }).first().click()`,
    `harness.page.locator('.side-row', { hasText: 'Other harnesses' })`,
    `page.locator('.settings-nav').locator('.side-row', { hasText: 'Other harnesses' })`,
    `page.locator('.side-row').filter({ hasText: 'Other harnesses' }).click()`,
    `page.locator('.side-row', { hasText: 'Other agents' }).click()`,
  ])
    assert.equal(retiredNavigationLocators(source).length, 1, source);
  for (const source of [
    `page.getByRole('heading', { name: 'Other harnesses' })`,
    `page.getByRole('main').locator('.side-row', { hasText: 'Other harnesses' })`,
    `page.locator('.side-row', { hasText: 'All harnesses' })`,
    `openSettingsSection(page, 'other-harnesses')`,
    `page.locator('.side-row', { hasText: label })`,
  ])
    assert.deepEqual(retiredNavigationLocators(source), [], source);
});

test('every E2E spec and helper avoids retired app navigation', () => {
  const violations: string[] = [];
  for (const file of treeFiles(path.join(root, 'tests/e2e'), /\.[cm]?tsx?$/)) {
    const source = readFileSync(file, 'utf8');
    for (const offset of retiredNavigationLocators(source, file))
      violations.push(`${path.relative(root, file)}:${source.slice(0, offset).split('\n').length}`);
  }
  assert.deepEqual(
    violations,
    [],
    'Use standaloneNewChat for app navigation, Back to app from Settings, Back to chats from pages, and openSettingsSection for hidden setup pages.',
  );
});

test('app, E2E and fixture changes retain the retired-navigation invariant in focused unit checks', () => {
  for (const changed of ['src/components/sidebar/SidebarNav.tsx', 'tests/e2e/new.spec.ts', 'tests/e2e/fixtures/sidebar.ts'])
    assert.ok(invariantTestsFor([changed]).includes('tests/e2eNavigationContract.test.ts'), changed);
});
