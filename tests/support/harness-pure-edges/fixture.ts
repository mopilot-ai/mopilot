// Common imports and mocked services for pure harness contract, account and ACP edge cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fx, reset } from '../harness-logic-fakes.ts';

const approvals = await import('../../../src/harness/approvalRequests.ts');
const caps = await import('../../../src/harness/caps.ts');
const ct = await import('../../../src/harness/claudeTranslate.ts');
const usage = await import('../../../src/harness/claudeUsage.ts');
const catalog = await import('../../../src/harness/codexCatalog.ts');
const compatCodex = await import('../../../src/harness/codexCompat.ts');
const tr = await import('../../../src/harness/codexTranslate.ts');
const commands = await import('../../../src/harness/commands.ts');
const entries = await import('../../../src/harness/entries.ts');
const instructions = await import('../../../src/harness/instructions.ts');
const permissionsMenu = await import('../../../src/harness/permissionsMenu.ts');
const registry = await import('../../../src/harness/registry.ts');
const acpSessions = await import('../../../src/harness/acpSessions.ts');
const plan = await import('../../../src/harness/switchPlan.ts');
const types = await import('../../../src/harness/types.ts');
const ownership = await import('../../../src/harness/ownership.ts');
const shell = await import('../../../src/harness/polyfills/shell.ts');
const compat = await import('../../../src/harness/compat.ts');

export {
  test,
  assert,
  fx,
  reset,
  approvals,
  caps,
  ct,
  usage,
  catalog,
  compatCodex,
  tr,
  commands,
  entries,
  instructions,
  permissionsMenu,
  registry,
  acpSessions,
  plan,
  types,
  ownership,
  shell,
  compat,
};
