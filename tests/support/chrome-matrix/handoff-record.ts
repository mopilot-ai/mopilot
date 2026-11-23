// handoff record browser control matrix cases using shared fake surfaces.
import { test, assert, workingInOf, workingEvents, reduceWorkingIn, composeHandoff } from './fixture.ts';

export function registerHandoffRecord() {
  /* ====================================================================== */
  /* Switch UX                                                               */
  /* ====================================================================== */

  test('CM-S01: the handoff record lists browser and desktop steps without their URLs, tokens, page text or grants', () => {
    const SECRET = 'tok_9f8e7d';
    const call = (server: string, tool: string, args: any, text: string) => ({
      type: 'mcpToolCall',
      server,
      tool,
      status: 'completed',
      arguments: args,
      result: { content: [{ type: 'text', text }] },
    });
    const turns = [
      {
        items: [
          { type: 'userMessage', content: [{ type: 'text', text: 'Sign in and download my statement' }] },
          // the in-app browser (Claude Code's mopilot_browser), Your Chrome, Claude in Chrome, the desktop
          call(
            'mopilot_browser',
            'navigate',
            { url: `https://bank.test/cb?code=${SECRET}` },
            `Page URL: https://bank.test/home?session=${SECRET}`,
          ),
          call(
            'sage_x',
            'sage_browser_navigate',
            { url: `https://bank.test/?access_token=${SECRET}` },
            'Granted read on bank.test for this chat',
          ),
          call(
            'claude-in-chrome',
            'navigate',
            { url: `https://bank.test/statements?sid=${SECRET}` },
            `Navigated to https://bank.test/statements?sid=${SECRET}`,
          ),
          call('mopilot_computer', 'left_click', { coordinate: [10, 20] }, 'Allowed control of Safari: always'),
          // Codex's computer use and Browser plugin run a program
          call(
            'cua_repl',
            'js',
            { code: `await tab.goto("https://bank.test/?token=${SECRET}")` },
            `Opened https://bank.test/?token=${SECRET}`,
          ),
          { type: 'agentMessage', text: 'Your statement is in Downloads.' },
        ],
      },
    ];
    const text = composeHandoff({
      from: 'claude',
      fromModel: 'Opus',
      mode: 'auto',
      turns: turns as any[],
      since: 0,
      targetModel: 'gpt',
      workspace: '## Workspace',
    });
    for (const step of [
      '- Tool mopilot_browser · navigate',
      '- Tool sage_x · sage_browser_navigate',
      '- Tool claude-in-chrome · navigate',
      '- Tool mopilot_computer · left_click',
      '- Tool cua_repl · js',
    ])
      assert.ok(text.includes(step), step);
    assert.equal(text.includes(SECRET), false, 'no token or session id');
    assert.equal(/bank\.test/.test(text), false, 'no page address');
    assert.equal(/Granted|Allowed control/.test(text), false, 'no grants');
  });

  test("CM-S02a: after a switch, the previous segment's working-in stack shows its end state, never as working on the new segment", () => {
    const desktop = (tool: string, args: any, status = 'completed') => ({
      type: 'mcpToolCall',
      server: 'mopilot_computer',
      tool,
      arguments: args,
      status,
      result: { content: [] },
    });
    // the Claude segment's last turn finished in Notes, then the user switched; that turn is still the chat's latest
    const last = { id: 'claude-t3', status: 'completed' as const, items: [desktop('app_click', { app: 'Notes' })] };
    const shown = workingInOf(last)!;
    assert.equal(shown.status, 'done');
    assert.equal(shown.apps[0].step.startsWith('Clicked'), true, shown.apps[0].step);
    // a turn the switch ended while a step was still running (its CLI went away) reads as stopped, in the past tense
    const cut = workingInOf({ id: 'claude-t4', status: 'interrupted', items: [desktop('app_click', { app: 'Notes' }, 'inProgress')] })!;
    assert.equal(cut.status, 'stopped');
    assert.equal(cut.apps[0].step.startsWith('Clicked'), true, cut.apps[0].step);
    // the new segment's first turn starts empty, and a late step of the old turn does not come back
    let s = workingEvents(last).reduce(reduceWorkingIn, null);
    s = reduceWorkingIn(s, { type: 'start', turnId: 'codex-t1' });
    s = reduceWorkingIn(s, { type: 'step', turnId: 'claude-t3', app: 'Notes', path: 'sage', step: 'Clicking in Notes' });
    assert.deepEqual(s, { turnId: 'codex-t1', status: 'working', apps: [] });
  });
}
