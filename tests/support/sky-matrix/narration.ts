// narration Sky matrix cases using shared fake harness and desktop fixtures.
import {
  test,
  assert,
  controlStep,
  narrationContexts,
  turnNarrationPriors,
  workingInOf,
  vendorProblem,
  VENDOR_SOURCES,
} from './fixture.ts';

export function registerNarration() {
  test('CM-V10: narration and "working in" name the app a program had bound at that point, carried across turns until a reset', () => {
    const cuaItem = (id: string, code: string) => ({
      type: 'mcpToolCall',
      id,
      server: 'cua_repl',
      tool: 'js',
      arguments: { code },
      status: 'completed',
      result: { content: [] },
    });
    const first = { id: 'T1', status: 'completed' as const, items: [cuaItem('a', "app = await cua.getApp('TextEdit');")] };
    const second = {
      id: 'T2',
      status: 'completed' as const,
      // the earlier step acts on TextEdit (bound in T1); only the later one rebinds `app` to Notes
      items: [cuaItem('b', 'await app.click([1, 1]);'), cuaItem('c', "app = await cua.getApp('Notes');\nawait app.click([2, 2]);")],
    };
    const priors = turnNarrationPriors([first, second]);
    const [beforeB] = narrationContexts(second.items, priors.get('T2'));
    assert.equal(controlStep(second.items[0], beforeB)?.app, 'TextEdit');
    assert.deepEqual(
      workingInOf(second, priors.get('T2'))!.apps.map((a) => a.app),
      ['Notes', 'TextEdit'],
    );
    // without what T1 bound, the first step names no app rather than the later one
    assert.deepEqual(
      workingInOf(second)!.apps.map((a) => a.app),
      ['Notes'],
    );
    // a js_reset, and a stopped turn (whose kernel may have been reset), carry nothing on
    const reset = { type: 'mcpToolCall', id: 'r', server: 'cua_repl', tool: 'js_reset', arguments: {}, status: 'completed' };
    const after = turnNarrationPriors([{ ...first, items: [...first.items, reset] }, second]);
    assert.equal(after.get('T2')!.size, 0);
    const stopped = turnNarrationPriors([{ ...first, status: 'interrupted' }, second]);
    assert.equal(stopped.get('T2')!.size, 0);
  });
}

export function registerChromePrompt() {
  test('CM-V14: Claude in Chrome asking in Chrome and getting no answer reads as "Confirm in Chrome" with the next step', () => {
    const timedOut =
      'No response to the Claude in Chrome permission prompt before it timed out, so the action was not run. The prompt opens as a small Claude window in Chrome: ask the user to keep Chrome visible and click Allow, then try again.';
    const step = controlStep({
      type: 'mcpToolCall',
      id: 'n',
      server: 'claude-in-chrome',
      tool: 'navigate',
      arguments: { url: 'https://x.test' },
      status: 'failed',
      error: { message: timedOut },
    });
    assert.equal(step?.problem?.kind, 'chromePromptTimedOut');
    assert.equal(step?.problem?.title, 'Confirm in Chrome');
    assert.match(step!.problem!.hint!, /click Allow there/);
    const unavailable = vendorProblem("The Claude in Chrome permission prompt window couldn't be opened, so the action was not run.", {
      sources: VENDOR_SOURCES.claudeInChrome,
      failed: true,
    });
    assert.equal(unavailable.kind, 'chromePromptUnavailable');
  });
}
