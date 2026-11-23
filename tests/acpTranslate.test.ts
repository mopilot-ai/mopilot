// The ACP item helpers the window draws a tool's approval card with, and the card's buttons from request_permission options.
// What translation makes of a session's updates is the Rust crate's own tests (core/crates/translate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { permissionChoices, toolItem as toolItemTyped } from '../src/harness/acpTranslate.ts';

// The assertions read each variant's fields directly.
const toolItem = (tc: unknown, cwd: string): any => toolItemTyped(tc, cwd);

test('ACP text extraction retains the empty fallback if a content field disappears while being read', async () => {
  const { blockText } = await import('../shared/acpItems/toolItems.mjs');
  let reads = 0;
  const content = {
    type: 'text',
    get text() {
      return reads++ === 0 ? 'text' : undefined;
    },
  };
  assert.equal(blockText(content), '');
});

test('tool kinds pick the card: a diff edits, read and search explore, fetch is web, the rest are tools', () => {
  const edit = toolItem(
    { toolCallId: 'e', kind: 'edit', status: 'completed', content: [{ type: 'diff', path: '/repo/a.ts', oldText: 'a', newText: 'b' }] },
    '/repo',
  );
  assert.equal(edit.type, 'fileChange');
  assert.equal(edit.changes[0].path, '/repo/a.ts');
  assert.match(edit.changes[0].diff, /-a\n\+b/);
  const add = toolItem(
    { toolCallId: 'n', kind: 'edit', content: [{ type: 'diff', path: '/repo/new.ts', oldText: null, newText: 'x' }] },
    '/repo',
  );
  assert.deepEqual(add.changes[0].kind, { type: 'add' });
  const read = toolItem({ toolCallId: 'r', kind: 'read', title: 'Read a.ts', locations: [{ path: '/repo/a.ts' }] }, '/repo');
  assert.equal(read.commandActions[0].type, 'read');
  assert.equal(read.commandActions[0].path, '/repo/a.ts');
  assert.equal(
    toolItem({ toolCallId: 's', kind: 'search', title: 'grep foo', rawInput: { pattern: 'foo' } }, '/repo').commandActions[0].query,
    'foo',
  );
  assert.deepEqual(toolItem({ toolCallId: 'f', kind: 'fetch', rawInput: { url: 'https://x.dev' } }, '/repo').action, {
    type: 'openPage',
    url: 'https://x.dev',
  });
  const mcp = toolItem(
    {
      toolCallId: 'm',
      kind: 'other',
      title: 'mcp__sage_0123456789ab__click',
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: 'no window' } }],
    },
    '/repo',
  );
  assert.equal(mcp.type, 'mcpToolCall');
  assert.equal(mcp.server, 'sage_0123456789ab');
  assert.equal(mcp.tool, 'click');
  assert.deepEqual(mcp.error, { message: 'no window' });
});

test('permission options as given: first allow is primary, first reject is Deny, the rest in the menu', () => {
  const c = permissionChoices([
    { optionId: 'a1', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'a2', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'r1', name: 'Reject', kind: 'reject_once' },
    { optionId: 'r2', name: 'Always reject', kind: 'reject_always' },
  ]);
  assert.deepEqual(c.primary, { label: 'Allow once', result: { optionId: 'a1' } });
  assert.deepEqual(c.deny, { optionId: 'r1' });
  assert.deepEqual(
    c.more.map((m) => m.result.optionId),
    ['a2', 'r2'],
  );
  // dsh: allow-once and reject-once only
  const d = permissionChoices([
    { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
    { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
  ]);
  assert.deepEqual(d.more, []);
  // no reject option: Deny cancels the request
  assert.deepEqual(permissionChoices([{ optionId: 'ok', name: 'OK', kind: 'allow_once' }]).deny, { optionId: null });
});

test('non-array ACP tool content cannot break the card, and valid blocks survive invalid neighbors', () => {
  for (const content of [{ type: 'content' }, 42, 'not blocks']) {
    const item = toolItem({ toolCallId: 'c', kind: 'execute', status: 'completed', content }, '/repo');
    assert.equal(item.type, 'commandExecution');
    assert.equal(item.aggregatedOutput, null);
  }
  const item = toolItem(
    { toolCallId: 'c', kind: 'execute', content: [null, 42, [], { type: 'content', content: { type: 'text', text: 'Kept' } }] },
    '/repo',
  );
  assert.equal(item.aggregatedOutput, 'Kept');
});
