// lint/rules/asserted-template-id.grit flags ids built from a non-null-asserted value and leaves checked ones alone (#2862).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';

test('[asserted-template-id] flags a template over an asserted value, not a checked or plain one', () => {
  const report = lintFixtures({
    'src/input.ts': String.raw`
      declare const basic: string | null;
      declare const o: { id?: string };
      export const bad = ${'`'}acp:${'$'}{basic!}${'`'};
      export const bad2 = ${'`'}x:${'$'}{o.id!}/y${'`'};
      export const good = basic ? ${'`'}acp:${'$'}{basic}${'`'} : null;
      export const plain = ${'`'}acp:${'$'}{o.id ?? 'none'}${'`'};
      export const asserted = basic!;
    `,
  });
  const findings = report.diagnostics.filter((d) => String(d.message).includes('[asserted-template-id]'));
  assert.equal(findings.length, 2, JSON.stringify(report));
});
