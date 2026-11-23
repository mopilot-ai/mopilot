// Whole-repository rule: a test file directly under tests/ never imports mobile's screen code (components/, screens/, MobileApp, App) with a literal path. tsconfig.node.json includes tests/*.ts, so such an import pulls React Native's types (setTimeout returns a number) into the Node project and breaks static (types) for electron/ and relay/, but only where mobile/node_modules is installed (CI), so a laptop without it does not see it. Pure-logic modules (outbox, reconnect, presentation/, push/, remote/) do not reach React Native and may be imported directly. Load screen code through a variable path (const appPath = '../mobile/src/MobileApp'; await import(appPath)) or through tests/support/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
/** `import ... from`, `import()` and `require()` of mobile's screen code with a literal path. */
const STATIC = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]\.\.\/mobile\/(?:src\/(?:components|screens)\/|src\/MobileApp|src\/App|App)/g;

/** The offending lines of one file's text (comments are not code, so a line that only mentions a path in one is skipped). */
export function staticMobileImports(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter((line) => new RegExp(STATIC.source).test(line))
    .map((line) => line.trim());
}

test('no test directly under tests/ imports mobile/ by a literal path', () => {
  const offenders: string[] = [];
  for (const f of readdirSync(here).filter((n) => /\.(ts|tsx)$/.test(n) && n !== path.basename(new URL(import.meta.url).pathname))) {
    const hits = staticMobileImports(readFileSync(path.join(here, f), 'utf8'));
    if (hits.length) offenders.push(`${f}: ${hits[0]}`);
  }
  assert.deepEqual(offenders, [], 'load mobile/ through a variable path or tests/support/ (see this file header)');
});

test('the rule sees each way of importing, and skips comments and variable paths', () => {
  assert.equal(staticMobileImports("import { A } from '../mobile/src/components/ui';").length, 1);
  assert.equal(staticMobileImports("const { A } = await import('../mobile/src/MobileApp');").length, 1);
  assert.equal(staticMobileImports("const a = require('../mobile/src/screens/Thread.tsx');").length, 1);
  assert.equal(staticMobileImports("// import { A } from '../mobile/src/components/ui'").length, 0);
  assert.equal(staticMobileImports("const appPath = '../mobile/src/MobileApp';\nawait import(appPath);").length, 0);
  assert.equal(staticMobileImports("import { createOutbox } from '../mobile/src/outbox.ts';").length, 0);
  assert.equal(staticMobileImports("import { x } from './support/phone/m3';").length, 0);
});
