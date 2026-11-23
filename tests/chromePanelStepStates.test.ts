// A step in Chrome's side panel reads in the state its call is in, as Claude in Chrome's timeline words every tool: running, done, failed (electron/capabilities/browser/chromePanelToolLines.cjs, chromePanelLive.cjs rowsOf) (#3046, B3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { rowsOf, stepOf } = require('../electron/capabilities/browser/chromePanelLive.cjs');
const { stateOfCall } = require('../electron/capabilities/browser/chromePanelToolLines.cjs');

/** a call's three lines: running, done, failed */
const lines = (item: any) => [
  stepOf({ ...item, status: 'inProgress' }),
  stepOf({ ...item, status: 'completed' }),
  stepOf({ ...item, status: 'failed' }),
];
const mcp = (tool: string, args?: object, server = 'mopilot_chrome') => ({
  type: 'mcpToolCall',
  server,
  tool,
  ...(args ? { arguments: args } : {}),
});
const computer = (action: string) => mcp('computer', { action });

test('a browser or desktop call has a line for each state; the failed ones are Claude in Chrome’s where its triple names the action', () => {
  assert.deepEqual(lines(computer('left_click')), ['Clicking', 'Clicked', 'Click failed']);
  assert.deepEqual(lines(computer('type')), ['Typing text', 'Typed text', 'Couldn’t type']);
  assert.deepEqual(lines(computer('scroll')), ['Scrolling', 'Scrolled', 'Couldn’t scroll']);
  assert.deepEqual(lines(computer('screenshot')), ['Taking a screenshot', 'Took a screenshot', 'Couldn’t take a screenshot']);
  assert.deepEqual(lines(computer('key')), ['Pressing keys', 'Pressed keys', 'Couldn’t press keys']);
  assert.deepEqual(lines(computer('wait')), ['Waiting', 'Waited', 'Couldn’t wait']);
  // a desktop tool by its name
  assert.deepEqual(lines(mcp('app_click', undefined, 'mopilot_computer')), ['Clicking', 'Clicked', 'Click failed']);
  assert.deepEqual(lines(mcp('read_page')), ['Reading the page', 'Read the page', 'Couldn’t read the page']);
  assert.deepEqual(lines(mcp('tabs_create')), ['Opening a new tab', 'Opened a new tab', 'Couldn’t open a new tab']);
  assert.deepEqual(lines(mcp('javascript_tool')), ['Running a script on the page', 'Ran a script on the page', 'Couldn’t run the script']);
  assert.deepEqual(lines(mcp('computer')), ['Using the browser', 'Used the browser', 'Couldn’t use the browser']);
});

test('navigation names its site in each state, and the browser’s own moves have theirs', () => {
  const go = (url?: string) => lines(mcp('navigate', url === undefined ? undefined : { url }));
  assert.deepEqual(go('https://a.example/x'), ['Opening a.example', 'Opened a.example', 'Couldn’t open a.example']);
  assert.deepEqual(go('nonsense'), ['Opening a page', 'Opened a page', 'Couldn’t open the page']);
  assert.deepEqual(go(), ['Opening a page', 'Opened a page', 'Couldn’t open the page']);
  assert.deepEqual(go('back'), ['Going back', 'Went back', 'Couldn’t go back']);
  assert.deepEqual(go('reload'), ['Reloading the page', 'Reloaded the page', 'Couldn’t reload the page']);
});

test('another server’s tool, and one with no name, say what was tried in each state', () => {
  assert.deepEqual(lines(mcp('lookup', undefined, 'maps')), ['Using maps/lookup', 'Used maps/lookup', 'Couldn’t use maps/lookup']);
  assert.deepEqual(lines({ type: 'mcpToolCall', tool: 'mystery' }), ['Using mystery', 'Used mystery', 'Couldn’t use mystery']);
  assert.deepEqual(lines({ type: 'mcpToolCall' }), ['Using a tool', 'Used a tool', 'Couldn’t use the tool']);
});

test('a basic harness joins the server and the tool (sage_<nonce>_chrome_navigate): the step reads as the tool does, never as the joined name', () => {
  const joined = (tool: string, args?: object) =>
    lines({ type: 'mcpToolCall', server: '', tool: `sage_3f880302123f_${tool}`, arguments: args });
  assert.deepEqual(joined('chrome_navigate', { url: 'https://a.example/x' }), [
    'Opening a.example',
    'Opened a.example',
    'Couldn’t open a.example',
  ]);
  assert.deepEqual(joined('chrome_read_page'), ['Reading the page', 'Read the page', 'Couldn’t read the page']);
  assert.deepEqual(joined('chrome_computer', { action: 'screenshot' }), [
    'Taking a screenshot',
    'Took a screenshot',
    'Couldn’t take a screenshot',
  ]);
  // a tool the table has no line for loses the server's nonce too
  assert.deepEqual(joined('lookup'), ['Using lookup', 'Used lookup', 'Couldn’t use lookup']);
  // a call that names its server keeps the tool as it is (the server is not part of a joined name)
  assert.deepEqual(lines({ type: 'mcpToolCall', server: 'maps', tool: 'sage_3f880302123f_lookup' }), [
    'Using maps/sage_3f880302123f_lookup',
    'Used maps/sage_3f880302123f_lookup',
    'Couldn’t use maps/sage_3f880302123f_lookup',
  ]);
});

test('MoPilot’s own tools keep the app’s triples; a command, an edit, a search, a sub-agent and the plan have theirs', () => {
  const server = 'sage_0423f8a30800';
  assert.deepEqual(lines(mcp('wrap_up', undefined, server)), ['Wrapping up', 'Wrapped up', 'Couldn’t wrap up']);
  // a command that ran and failed is not one that could not run
  assert.deepEqual(lines({ type: 'commandExecution', command: 'npm test' }), ['Running npm test', 'Ran npm test', 'npm test failed']);
  assert.deepEqual(lines({ type: 'commandExecution', command: '' }), ['Running a command', 'Ran a command', 'A command failed']);
  // the model's own description is its wording in every state
  assert.deepEqual(lines({ type: 'commandExecution', command: 'x', description: 'Check types' }), [
    'Check types',
    'Check types',
    'Check types',
  ]);
  const files = (kind: string, ...paths: string[]) => ({
    type: 'fileChange',
    changes: paths.map((path) => ({ path, kind: { type: kind } })),
  });
  assert.deepEqual(lines(files('update', 'src/a.md')), ['Editing a.md', 'Edited a.md', 'Couldn’t edit a.md']);
  assert.deepEqual(lines(files('add', 'a.md', 'b.md', 'c.md')), [
    'Creating a.md, b.md and 1 more',
    'Created a.md, b.md and 1 more',
    'Couldn’t create a.md, b.md and 1 more',
  ]);
  assert.deepEqual(lines({ type: 'fileChange' }), ['Editing files', 'Edited files', 'Couldn’t edit files']);
  assert.deepEqual(lines({ type: 'webSearch', query: 'tide times' }), [
    'Searching for tide times',
    'Searched for tide times',
    'Couldn’t search for tide times',
  ]);
  assert.deepEqual(lines({ type: 'webSearch' }), ['Searching the web', 'Searched the web', 'Couldn’t search the web']);
  assert.deepEqual(lines({ type: 'collabAgentToolCall' }), ['Running a sub-agent', 'Ran a sub-agent', 'Couldn’t run the sub-agent']);
  assert.deepEqual(lines({ type: 'plan' }), ['Updating the plan', 'Updated the plan', 'Couldn’t update the plan']);
  assert.equal(stepOf({ type: 'reasoning' }), null);
});

test('a call is failed on its status, an error or an error result; running only while its harness says so; no status is done', () => {
  assert.equal(stateOfCall({ status: 'failed' }), 'failed');
  // one the user declined was not run: not a failed one
  assert.equal(stateOfCall({ status: 'declined' }), 'done');
  assert.equal(stateOfCall({ error: { message: 'no' } }), 'failed');
  assert.equal(stateOfCall({ result: { isError: true } }), 'failed');
  assert.equal(stateOfCall({ status: 'inProgress' }), 'running');
  assert.equal(stateOfCall({ status: 'completed' }), 'done');
  assert.equal(stateOfCall({}), 'done');
  // a call its turn was stopped under runs no more; a failure is still a failure
  assert.equal(stateOfCall({ status: 'inProgress' }, true), 'done');
  assert.equal(stateOfCall({ status: 'failed' }, true), 'failed');
  // a status this code has not met is a finished call
  assert.equal(stateOfCall({ status: 'pending' }), 'done');
});

const user = { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'Go' }] };
const call = (id: string, status?: string) => ({ ...mcp('read_page'), id, ...(status ? { status } : {}) });
/** the steps' lines and states, as a read of a chat main is running (`running`) or of an idle one */
const states = (turns: any[], running = true) =>
  rowsOf(turns, { running })
    .rows.filter((r: any) => r.role === 'step')
    .map((r: any) => [r.text, r.state]);

test('rows carry a state only when it is not done, so a harness with no status reads as before', () => {
  assert.deepEqual(
    states([{ id: 't', status: 'inProgress', items: [user, call('a', 'completed'), call('b', 'failed'), call('c', 'inProgress')] }]),
    [
      ['Read the page', undefined],
      ['Couldn’t read the page', 'failed'],
      ['Reading the page', 'running'],
    ],
  );
  assert.deepEqual(states([{ id: 't', items: [user, call('a')] }]), [['Read the page', undefined]]);
});

test('an idle chat, and an older page of rows, have no call running, whatever a stale history says', () => {
  const stale = [{ id: 't', status: 'inProgress', items: [user, call('a', 'inProgress'), call('b', 'failed')] }];
  assert.deepEqual(states(stale, false), [
    ['Read the page', undefined],
    ['Couldn’t read the page', 'failed'],
  ]);
  // not said, not running
  assert.deepEqual(
    rowsOf(stale).rows.map((r: any) => r.state),
    [undefined, undefined, 'failed'],
  );
});

test('a call left running by a stopped or failed turn, or by a turn that another followed, reads as done', () => {
  const items = [user, call('a', 'inProgress')];
  for (const status of ['interrupted', 'failed']) assert.deepEqual(states([{ id: 't', status, items }]), [['Read the page', undefined]]);
  // a turn that completed with a call the harness never closed is still running (Claude's transcript replays it as completed)
  assert.deepEqual(states([{ id: 't', status: 'completed', items }]), [['Reading the page', 'running']]);
  assert.deepEqual(
    states([
      { id: 't1', status: 'completed', items },
      { id: 't2', status: 'inProgress', items: [user, call('b', 'inProgress')] },
    ]),
    [
      ['Read the page', undefined],
      ['Reading the page', 'running'],
    ],
  );
  // a lone malformed turn list reads as no rows
  assert.deepEqual(rowsOf('nope').rows, []);
});
