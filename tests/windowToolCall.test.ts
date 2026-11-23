// The window tools' lines in a transcript (src/lib/windowToolCall.ts), from any harness's tool call item: Claude
// Desktop's words running and done, "Left the window as it was" when the call changed nothing, and a failure as one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sageCallLine, windowCallLine } from '../src/lib/windowToolCall.ts';

const call = (tool: string, args: Record<string, unknown>, o: Record<string, unknown> = {}) => ({
  type: 'mcpToolCall',
  server: 'sage_ab12',
  tool,
  arguments: args,
  status: 'completed',
  result: { content: [{ type: 'text', text: JSON.stringify({ changed: true }) }] },
  ...o,
});
const text = (item: unknown) => windowCallLine(item)?.text ?? null;

test('each tool and target reads as Claude Desktop’s line, running and done', () => {
  for (const [target, doing, done] of [
    ['split', 'Opening session in split view', 'Opened session in split view'],
    ['window', 'Opening session in new window', 'Opened session in new window'],
    ['focus', 'Opening session', 'Opened session'],
  ]) {
    assert.equal(text(call('open_session_in', { target }, { status: 'inProgress' })), doing);
    assert.equal(text(call('open_session_in', { target })), done);
  }
  assert.equal(text(call('open_session_in', {})), 'Opened session in split view', 'a call with no target yet');
  assert.equal(text(call('close_split', {}, { status: 'inProgress' })), 'Closing split view');
  assert.equal(text(call('close_split', {})), 'Closed split view');
  assert.equal(text(call('get_window_layout', {}, { status: 'inProgress' })), 'Checking window layout');
  assert.equal(text(call('get_window_layout', {})), 'Checked window layout');
  // a Codex dynamic call reads the same; a call still with no status is done once it answered
  assert.equal(text({ ...call('close_split', {}), type: 'dynamicToolCall' }), 'Closed split view');
  assert.equal(text(call('close_split', {}, { status: undefined })), 'Closed split view');
});

test('a call that changed nothing says so; a failure reads as one; the layout check is never "left as it was"', () => {
  const nothing = { content: [{ type: 'text', text: JSON.stringify({ changed: false, outcome: 'not_on_screen' }) }] };
  assert.equal(text(call('open_session_in', { target: 'split' }, { result: nothing })), 'Left the window as it was');
  assert.equal(text(call('close_split', {}, { result: nothing })), 'Left the window as it was');
  assert.equal(
    text(call('get_window_layout', {}, { result: { content: [{ type: 'text', text: '{"on_screen":false,"changed":false}' }] } })),
    'Checked window layout',
  );
  assert.equal(
    text(call('open_session_in', { target: 'split' }, { result: { content: [{ type: 'text', text: 'not json' }] } })),
    'Opened session in split view',
  );
  assert.deepEqual(windowCallLine(call('open_session_in', { target: 'split' }, { status: 'failed' })), {
    text: 'Couldn’t open session in split view',
    failed: true,
  });
  assert.equal(text(call('close_split', {}, { error: { message: 'x' } })), 'Couldn’t close split view');
  assert.equal(text(call('get_window_layout', {}, { result: { isError: true } })), 'Couldn’t check window layout');
  assert.equal(text(call('open_session_in', { target: 'window' }, { status: 'failed' })), 'Couldn’t open session in new window');
  assert.equal(text(call('open_session_in', { target: 'focus' }, { status: 'failed' })), 'Couldn’t open session');
});

test('another tool, another server’s tool of the same name, or not a tool call is not a window call', () => {
  assert.equal(windowCallLine(call('start_session', {})), null);
  assert.equal(windowCallLine({ ...call('close_split', {}), server: 'ccd_window' }), null);
  assert.equal(windowCallLine({ type: 'commandExecution' }), null);
  assert.equal(windowCallLine(null), null);
  // the combined line still reads a session call first
  assert.equal(sageCallLine(call('start_session', { title: 'T', initiation: 'user_asked' }))?.text, 'Started session');
  assert.equal(sageCallLine(call('close_split', {}))?.text, 'Closed split view');
  assert.equal(sageCallLine({ type: 'commandExecution' }), null);
});

test('the pane tools read as Claude Desktop’s lines: show_pane by its pane, close_pane and open_terminal_tab', () => {
  for (const [pane, doing, done] of [
    ['diff', 'Opening diff', 'Opened diff'],
    ['file', 'Opening file', 'Opened file'],
    ['terminal', 'Opening terminal', 'Opened terminal'],
    ['tasks', 'Opening background tasks', 'Opened background tasks'],
    ['preview', 'Opening browser', 'Opened browser'],
    ['artifact', 'Opening artifact', 'Opened artifact'],
    ['gallery', 'Opening pane', 'Opened pane'],
    [undefined, 'Opening pane', 'Opened pane'],
  ]) {
    assert.equal(text(call('show_pane', { pane }, { status: 'inProgress' })), doing);
    assert.equal(text(call('show_pane', { pane })), done);
  }
  assert.equal(text(call('show_pane', { pane: 'diff' }, { status: 'failed' })), 'Couldn’t open diff');
  assert.equal(text(call('close_pane', { pane: 'diff' })), 'Closed pane');
  assert.equal(text(call('close_pane', { pane: 'diff' }, { status: 'inProgress' })), 'Closing pane');
  assert.equal(text(call('open_terminal_tab', {})), 'Opened terminal tab');
  assert.equal(text(call('open_terminal_tab', {}, { status: 'failed' })), 'Couldn’t open terminal tab');
  // answered without a change (not on screen, not the focused session)
  const off = { result: { content: [{ type: 'text', text: '{"changed":false,"outcome":"not_on_screen"}' }] } };
  assert.equal(text(call('show_pane', { pane: 'diff' }, off)), 'Left the window as it was');
});
