// Reserved object names must use real table fallbacks across renderer, shared and main-process mappings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import './support/dom.ts';
import { macKeys } from '../src/lib/agentNarration/common.ts';
import { desktopStep } from '../src/lib/agentNarration/tools.ts';
import { goalNotice } from '../shared/goalNotice.mjs';
import { accountGate } from '../shared/caps.mjs';
import { ownGet, ownTable } from '../shared/ownTable.mjs';
import { HARNESS_LABEL } from '../shared/handoff.mjs';
import { effortLabel, comboFromEvent } from '../src/lib/format.ts';
import { toolVerb } from '../src/lib/tasks.ts';
import { goalStatusLabel } from '../src/lib/codexGoals.ts';
import { roleOf } from '../src/lib/pageAnnotations.ts';
import { appearanceVars } from '../src/lib/appearance.ts';
import { handlerFor, registerSemantic } from '../src/harness/adapters/semantics.ts';

import { claudeCommands } from '../src/harness/commands.ts';
import { resolveSection } from '../src/lib/settingsNav.ts';
import { chromeApproval } from '../src/harness/chromeApproval.ts';
import { blockedOf } from '../src/lib/blockedChoices.ts';

const require = createRequire(import.meta.url);
const cursor = require('../electron/harness/quirks/cursor.cjs');

test('the table constructor preserves declared keys and leaves inherited names absent', () => {
  const declared = JSON.parse('{"constructor":"declared","__proto__":"explicit","known":0}');
  const table = ownTable(declared);
  assert.equal(table.constructor, 'declared');
  assert.equal(table.__proto__, 'explicit');
  assert.equal(table.known ?? 1, 0);
  assert.equal(table.toString ?? 'fallback', 'fallback');
  assert.equal(declared.toString, Object.prototype.toString, 'construction does not mutate the input');
});
for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
  test(`unknown mapped value ${name} remains a string or documented fallback`, async () => {
    assert.equal(effortLabel(name), name[0].toUpperCase() + name.slice(1));
    assert.equal(toolVerb(name), `Using ${name}`);
    assert.equal(goalStatusLabel(name as any), name);
    assert.equal(roleOf({ tag: name }), 'generic');
    assert.equal(roleOf({ tag: 'input', type: name }), 'textbox');
    assert.equal((HARNESS_LABEL as any)[name] ?? 'another harness', 'another harness');
    assert.equal(comboFromEvent({ code: name, key: 'c', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }, false), 'C');
    const vars = appearanceVars({ codeFontSize: 12, fontFamily: name, accent: name } as any, 14, false);
    assert.ok(vars['--font-sans'].startsWith(`"${name}"`));
    const plan = cursor.extensions['cursor/update_todos']({ todos: [{ title: 'A', status: name }] });
    assert.equal(plan.update.entries[0].status, 'pending');
    assert.equal(await handlerFor(name as any, 'goal'), null);
  });
}

test('valid mapped values and explicitly registered reserved harness names keep their behavior', async () => {
  assert.equal(effortLabel('high'), 'High');
  assert.equal(toolVerb('bash'), 'Running a command');
  assert.equal(goalStatusLabel('active'), 'Active');
  assert.equal(roleOf({ tag: 'button' }), 'button');
  assert.equal(cursor.extensions['cursor/update_todos']({ todos: [{ status: 'done' }] }).update.entries[0].status, 'completed');
  const handler = () => 'owned';
  registerSemantic('__proto__' as any, 'goal', handler);
  assert.equal(await handlerFor('__proto__' as any, 'goal'), handler);
  assert.equal(await handlerFor('hasOwnProperty' as any, 'goal'), null);
});

for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
  test(`unknown narration and account values ${name} use their ordinary fallbacks`, () => {
    assert.equal(macKeys(name), name[0].toUpperCase() + name.slice(1));
    assert.deepEqual(desktopStep(name, {}, ''), ['Used your computer', 'Using your computer']);
  });
  test(`unknown account reason ${name} is unavailable`, () => {
    assert.deepEqual(accountGate({ fast: false, fastBlocked: name } as any), {
      speed: { layer: 'account', code: 'account.noFast.unavailable' },
    });
  });
}

for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
  test(`unknown command, route, approval and extension name ${name} is not a declared entry`, () => {
    const command = claudeCommands([{ name, description: 'custom' }] as any).native[0];
    assert.equal(command.semantic, undefined);
    assert.deepEqual(resolveSection(name), { section: name, tab: undefined });
    assert.equal(chromeApproval('mcp__claude-in-chrome__computer', { action: name })?.action, `Use the browser (${name})`);
    assert.equal(require('../electron/capabilities/browser/extensionResults.cjs').sageName(name), null);
  });
}
test('an unknown refusal reason does not invent browser recovery choices', () => {
  assert.equal(
    blockedOf({
      id: 'x',
      tool: 'browser_click',
      arguments: {},
      result: { content: [{ type: 'text', text: '<refusal reason="__proto__">no</refusal>' }] },
    }),
    null,
  );
});

test('unrecognized goal status never creates a system notification', () => {
  for (const status of ['__proto__', 'constructor', 'toString', 'hasOwnProperty'])
    assert.equal(goalNotice({ status: 'active' } as any, { status } as any), null);
});

test('ownGet answers own entries only, for a table that crossed a boundary or none at all', () => {
  const table = JSON.parse('{"known":1,"__proto__":2}');
  assert.equal(ownGet(table, 'known'), 1);
  assert.equal(ownGet(table, '__proto__'), 2);
  for (const name of ['constructor', 'toString', 'missing']) assert.equal(ownGet(table, name), undefined, name);
  assert.equal(ownGet({ known: 1 }, '__proto__'), undefined);
  assert.equal(ownGet(null, 'known'), undefined);
  assert.equal(ownGet(undefined, 'known'), undefined);
});
