// Claude Desktop's short action words for step-group summaries and batch rows (src/lib/agentNarration/verbs.ts, #4463).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlVerb, foldPhrases, inSteps, shortToolName, verbPhrases, verbSummary } from '../src/lib/agentNarration/verbs.ts';

const words = (name: string, args: Record<string, unknown> = {}, surface: 'browser' | 'desktop' = 'browser') => {
  const v = controlVerb(name, args, surface);
  return [v.key, v.done, v.doing, v.steps];
};

test('controlVerb: computer actions, browser tools and desktop tools read as Claude Desktop words them', () => {
  assert.deepEqual(words('computer', { action: 'screenshot' }), ['browser:screenshot', 'Captured page', 'Capturing page', undefined]);
  assert.deepEqual(words('computer', { action: 'triple_click' }), ['browser:triple_click', 'Triple-clicked', 'Triple-clicking', undefined]);
  assert.deepEqual(words('tabs_context'), ['browser:tabs_context', 'Checked tabs', 'Checking tabs', undefined]);
  assert.deepEqual(words('list_connected_browsers'), [
    'browser:list_connected_browsers',
    'Checked connected browsers',
    'Checking connected browsers',
    undefined,
  ]);
  // the same action is a capture of the screen on the desktop, in an app too (as its row reads)
  assert.deepEqual(words('screenshot', {}, 'desktop'), ['desktop:screenshot', 'Captured screen', 'Capturing screen', undefined]);
  assert.deepEqual(words('app_screenshot', {}, 'desktop'), words('screenshot', {}, 'desktop'));
  // an app action reads as the action, and merges with it
  assert.equal(controlVerb('app_click', {}, 'desktop').key, controlVerb('click', {}, 'desktop').key);
  assert.deepEqual(words('left_click', {}, 'desktop'), ['desktop:left_click', 'Clicked', 'Clicking', undefined]);
  // another name for the same action is the same action
  assert.deepEqual(words('evaluate'), words('javascript_tool'));
  assert.deepEqual(words('take_screenshot', {}, 'desktop'), words('screenshot', {}, 'desktop'));
  // navigate's moves open nothing
  assert.deepEqual(words('navigate', { url: 'https://a.test' }), ['browser:navigate', 'Opened', 'Opening', undefined]);
  assert.deepEqual(words('navigate', { url: 'back' }), ['browser:navigate_back', 'Went back', 'Going back', undefined]);
  assert.deepEqual(words('navigate', { url: 'reload' }), ['browser:navigate_reload', 'Reloaded page', 'Reloading page', undefined]);
  // a tool the tables don't know
  assert.deepEqual(words('something_new'), ['browser:other', 'Used the browser', 'Using the browser', undefined]);
  assert.deepEqual(words('something_new', {}, 'desktop'), ['desktop:other', 'Used your computer', 'Using your computer', undefined]);
});

test('controlVerb: a batch names its first three different actions, "+N" for the actions past them, and its step count', () => {
  const browser = controlVerb(
    'browser_batch',
    {
      actions: [
        { name: 'computer', input: { action: 'left_click' } },
        { name: 'computer', input: { action: 'wait' } },
        { name: 'browser_computer', input: { action: 'left_click' } },
        { name: 'mcp__x__computer', input: { action: 'screenshot' } },
        { name: 'find', input: { query: 'x' } },
        { name: 'tabs_context_mcp' },
      ],
    },
    'browser',
  );
  assert.equal(browser.done, 'Clicked, waited, captured page +2');
  assert.equal(browser.doing, 'Clicking, waiting, capturing page +2');
  assert.equal(browser.steps, 6);
  // two batches of the same actions merge; a different one does not
  assert.equal(
    controlVerb('batch', { actions: [{ name: 'computer', input: { action: 'left_click' } }] }, 'browser').key,
    controlVerb('batch', { actions: [{ tool: 'computer', args: { action: 'left_click' } }] }, 'browser').key,
  );
  // a desktop batch's actions are the actions themselves; an app batch's are app actions
  const desktop = controlVerb('computer_batch', { actions: [{ action: 'key' }, { action: 'type' }] }, 'desktop');
  assert.deepEqual([desktop.done, desktop.steps], ['Pressed key, typed', 2]);
  const app = controlVerb('app_batch', { actions: [{ action: 'screenshot' }, { action: 'click' }, { action: 'app_click' }] }, 'desktop');
  assert.deepEqual([app.done, app.steps], ['Captured screen, clicked', 3]);
  // nothing to name: the old count, in either surface
  assert.deepEqual(words('batch', {}), ['browser:batch:0', 'Ran 0 browser actions', 'Running 0 browser actions', undefined]);
  assert.deepEqual(words('batch', { actions: 'x' }, 'desktop'), ['desktop:batch:0', 'Ran 0 actions', 'Running 0 actions', undefined]);
  // batches of actions it can't name merge only at the same size
  const unnamed = (n: number) => ({ verb: controlVerb('batch', { actions: Array(n).fill({}) }, 'browser'), failed: false });
  assert.equal(verbSummary([unnamed(3), unnamed(5), unnamed(3)]), 'Ran 3 browser actions 2 times, ran 5 browser actions');
  // a batch ending on an action it can't name is still a named batch
  const mixed = controlVerb('batch', { actions: [{ name: 'find' }, { name: 'new_tool' }] }, 'browser');
  assert.deepEqual([mixed.done, mixed.steps, mixed.unknown], ['Found, used the browser', 2, undefined]);
  // a batch of form inputs is one fill, with no step count of its own
  assert.deepEqual(words('browser_batch', { actions: [{ name: 'form_input' }, { name: 'fill_form' }] }), [
    'browser:form_input',
    'Filled in a field',
    'Filling in a field',
    undefined,
  ]);
  // actions it can't name keep the count; one it can is named beside them
  assert.equal(controlVerb('batch', { actions: [null, {}] }, 'browser').done, 'Ran 2 browser actions');
  assert.equal(controlVerb('batch', { actions: [{}, { name: 'find' }] }, 'browser').done, 'Used the browser, found');
  assert.equal(inSteps(1), 'in 1 step');
  assert.equal(shortToolName('mcp__mopilot_chrome__tabs_context_mcp'), 'tabs_context');
  assert.equal(shortToolName(undefined), '');
});

const act = (key: string, done: string, failed = false) => ({ verb: { key, done, doing: done }, failed });

test('verbSummary: equal actions merge with a count, failures are counted, and past four phrases the rest fold', () => {
  assert.equal(
    verbSummary([act('a', 'Checked tabs'), act('b', 'Clicked'), act('a', 'Checked tabs'), act('c', 'Captured page', true)]),
    'Checked tabs 2 times, clicked, captured page (1 failed)',
  );
  // four phrases stay; a fifth folds the last two into "and N more actions" (N calls), their failures after it
  const four = [act('a', 'Opened'), act('b', 'Clicked'), act('c', 'Typed'), act('d', 'Waited')];
  assert.equal(verbSummary(four), 'Opened, clicked, typed, waited');
  assert.equal(
    verbSummary([...four, act('e', 'Found', true), act('d', 'Waited'), act('a', 'Opened', true)]),
    'Opened 2 times (1 failed), clicked, typed, and 3 more actions, 1 failed',
  );
  assert.equal(verbSummary([...four, act('e', 'Found')]), 'Opened, clicked, typed, and 2 more actions');
  assert.equal(verbSummary([]), '');
  // a phrase that already says its count gets no "times"
  assert.equal(
    foldPhrases([{ key: 'cmd', words: 'ran 2 commands', count: 2, failed: 0, counted: true }, ...verbPhrases([act('a', 'Opened')])]),
    'ran 2 commands, opened',
  );
});
