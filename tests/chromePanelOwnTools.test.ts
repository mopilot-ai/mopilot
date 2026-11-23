// What Chrome's side panel shows of two things the app words itself (capabilities/browser/chromePanelLive.cjs): MoPilot's own tools, as the chat view's table words them, and the account running out of usage (#3046).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { rowsOf, stepOf } = require('../electron/capabilities/browser/chromePanelLive.cjs');

test('MoPilot’s own tools read as the app words them, never as the server’s nonce and the tool’s raw name', () => {
  const own = (o: object) => stepOf({ type: 'mcpToolCall', ...o });
  const server = 'sage_0423f8a30800';
  assert.equal(own({ server, tool: 'wrap_up' }), 'Wrapped up');
  assert.equal(own({ server, tool: 'wrap_up', status: 'completed' }), 'Wrapped up');
  assert.equal(own({ server, tool: 'update_task_list', status: 'inProgress' }), 'Updating task list');
  assert.equal(own({ server, tool: 'wrap_up', status: 'failed' }), 'Couldn’t wrap up');
  assert.equal(own({ server, tool: 'wrap_up', error: { message: 'refused' } }), 'Couldn’t wrap up');
  assert.equal(own({ server, tool: 'wrap_up', result: { isError: true } }), 'Couldn’t wrap up');
  // each harness's form of the name: Claude Code's mcp__ prefix, a basic harness's joined name
  assert.equal(own({ tool: 'mcp__sage_3f880302123f__wrap_up' }), 'Wrapped up');
  assert.equal(own({ tool: 'sage_3f880302123f_update_task_list' }), 'Updated task list');
  // a tool the table doesn't word reads as any other server's
  assert.equal(own({ server, tool: 'brand_new_tool' }), `Used ${server}/brand_new_tool`);
  // another server's tool of the same name keeps its server
  assert.equal(own({ server: 'github', tool: 'wrap_up' }), 'Used github/wrap_up');
  // MoPilot's browser tools are still read as browser steps
  assert.equal(
    own({ server: 'mopilot_browser', tool: 'mcp__mopilot_browser__navigate', arguments: { url: 'https://a.example/x' } }),
    'Opened a.example',
  );
});

test('the account running out of usage shows on the panel where the turn stopped', () => {
  const { rows } = rowsOf([
    {
      items: [
        { type: 'agentMessage', text: 'Opening the page' },
        {
          type: 'statusNote',
          id: 'l1',
          kind: 'limit',
          text: "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage",
        },
        { type: 'statusNote', id: 'l2', kind: 'limit', text: '' },
      ],
    },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.role, r.text]),
    [
      ['assistant', 'Opening the page'],
      ['note', "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage"],
    ],
  );
  // the limit's row says so, the account's move does not
  assert.deepEqual(
    rows.map((r) => r.limit),
    [undefined, true],
  );
});
