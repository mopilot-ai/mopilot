// Keeps entrypoint instructions within their budgets and their local references usable in every changed snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { auditInstructions } from '../scripts/instruction-budget.mjs';

export const GUARDS = ['AGENTS.md', '.agents/skills/', 'scripts/instruction-budget.mjs'];

test('always-loaded rules and marked workflow skills stay within budget with intact local references', () => {
  const result = auditInstructions(path.join(import.meta.dirname, '..'));
  assert.deepEqual(result.issues, [], JSON.stringify(result));
});
