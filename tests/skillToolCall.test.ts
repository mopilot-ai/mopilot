// A skill as the thread words it (src/session/skillToolCall.ts, src/harness/commands.ts sentSkill): Claude Code's Skill tool
// call is the skill it loaded, never "Called Skill", and a sent "/name args" starts a skill only when the harness lists it as one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { skillCall, skillCallVerb, runningSkillLabel } from '../src/session/skillToolCall.ts';
import { sentSkill, claudeCommands, acpCommands } from '../src/harness/commands.ts';
import { summarizeSteps } from '../src/components/thread/items/stepModel.ts';
import { activeStepLabel } from '../src/components/thread/items/presentation.tsx';

const text = (t: string) => ({ content: [{ type: 'text', text: t }], structuredContent: null, _meta: null });
const call = (extra: any = {}) => ({
  type: 'mcpToolCall',
  id: 'k1',
  server: '',
  tool: 'Skill',
  arguments: { skill: 'fix-bug', args: '  tidy the login  ' },
  status: 'completed',
  result: text('Launching skill: fix-bug'),
  error: null,
  ...extra,
});

test('a loaded skill reads as the skill, its arguments and Claude Code\'s "Successfully loaded skill"', () => {
  assert.deepEqual(skillCall(call()), { name: 'fix-bug', args: 'tidy the login', state: 'loaded', output: 'Successfully loaded skill' });
  // no result text yet on a finished call, and one with no status (a replayed item): still loaded
  assert.equal(skillCall(call({ result: null }))?.output, 'Successfully loaded skill');
  assert.equal(skillCall(call({ status: undefined }))?.state, 'loaded');
  // a forked skill answers with what it did: that is shown as it is
  assert.equal(skillCall(call({ result: text('Fixed it.') }))?.output, 'Fixed it.');
  // a typed slash, no arguments, a dynamic tool call
  assert.deepEqual(skillCall(call({ type: 'dynamicToolCall', arguments: { skill: '/plugin:review' } })), {
    name: 'plugin:review',
    args: '',
    state: 'loaded',
    output: 'Successfully loaded skill',
  });
  assert.equal(skillCallVerb(skillCall(call())!), 'Loaded skill');
});

test('a running skill and one that failed say so; a failure keeps what the harness said', () => {
  const running = skillCall(call({ status: 'inProgress', result: null }))!;
  assert.equal(running.state, 'running');
  assert.equal(running.output, '');
  assert.equal(skillCallVerb(running), 'Running skill');
  // one Stop cut off before it answered only started
  assert.equal(skillCallVerb(running, true), 'Started skill');
  // the person refused it: that is what it says, not a failure to load
  const declined = skillCall(call({ status: 'declined', result: null, error: { message: 'Permission denied' } }))!;
  assert.equal(declined.state, 'declined');
  assert.equal(skillCallVerb(declined), 'Declined skill');
  assert.equal(skillCallVerb(declined, true), 'Declined skill');
  for (const extra of [
    { status: 'failed', result: null, error: { message: 'Unknown skill: fix-bug' } },
    { status: 'completed', error: { message: 'Unknown skill: fix-bug' } },
  ]) {
    const failed = skillCall(call(extra))!;
    assert.equal(failed.state, 'failed', JSON.stringify(extra));
    assert.equal(failed.output, 'Unknown skill: fix-bug');
    assert.equal(skillCallVerb(failed), 'Couldn’t load skill');
  }
  assert.equal(skillCall(call({ result: { isError: true, content: [] } }))?.state, 'failed');
});

test('only the built-in Skill tool naming a skill is a skill call', () => {
  for (const item of [
    null,
    { type: 'commandExecution', tool: 'Skill' },
    call({ tool: 'Read' }),
    call({ tool: undefined }),
    // an MCP server's tool of the same name is that server's
    call({ server: 'acme' }),
    call({ server: undefined, tool: 'mcp__acme__Skill' }),
    call({ arguments: {} }),
    call({ arguments: { skill: '  ' } }),
    call({ arguments: { skill: 3 } }),
    call({ arguments: null }),
  ])
    assert.equal(skillCall(item), null, JSON.stringify(item));
});

test('a group counts the skills it loaded apart from its tools, and the running line names the skill', () => {
  const step = (item: any) => ({ kind: 'tool', item }) as any;
  assert.equal(summarizeSteps([step(call())]).text, 'Loaded a skill');
  assert.equal(
    summarizeSteps([step(call()), step(call({ id: 'k2' })), { kind: 'read', item: {} } as any]).text,
    'Read a file, loaded 2 skills',
  );
  // one that did not load loaded nothing: it stays a tool call, like one still running
  assert.equal(
    summarizeSteps([step(call({ status: 'failed', error: { message: 'x' } })), step(call({ status: 'inProgress' }))]).text,
    'Called 2 tools',
  );
  assert.equal(activeStepLabel(step(call({ status: 'inProgress' }))), 'Running skill /fix-bug');
  assert.equal(runningSkillLabel(call({ tool: 'Read' })), null);
  assert.equal(activeStepLabel(step(call({ tool: 'Other' }))), 'Calling Other');
});

test('a sent message starts a skill only when its first token is one the harness lists as a skill', () => {
  const claude = claudeCommands(
    [{ name: 'fix-bug', description: 'Fix a bug' }, { name: 'compact', description: 'Compact', builtin: true } as any],
    { skills: ['fix-bug'] },
  );
  // what follows the name keeps the space or line break it was sent with
  assert.deepEqual(sentSkill('/fix-bug tidy\nthe login', claude), { name: 'fix-bug', rest: ' tidy\nthe login' });
  assert.deepEqual(sentSkill('/fix-bug\n  step 1\n', claude), { name: 'fix-bug', rest: '\n  step 1' });
  assert.deepEqual(sentSkill('  /fix-bug', claude), { name: 'fix-bug', rest: '' });
  // a command, a skill named later in the text, plain text, a path, and no command list yet
  assert.equal(sentSkill('/compact', claude), null);
  assert.equal(sentSkill('please /fix-bug', claude), null);
  assert.equal(sentSkill('/unknown thing', claude), null);
  assert.equal(sentSkill('/usr/local/bin is missing', claude), null);
  assert.equal(sentSkill('/fix-bug now', null), null);
  // a basic harness's commands carry no skill kind: its messages stay text
  assert.equal(sentSkill('/fix-bug now', acpCommands('Kimi', [{ name: 'fix-bug', description: '' }])), null);
});
