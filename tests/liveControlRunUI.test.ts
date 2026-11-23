// A running turn's finished browser and desktop steps show as they land, on every harness and activity look (#1952).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h, render, settle, setStore, T, text, user, turn, chat, view } from './support/thread-view/fixture.ts';
const { StepGroup } = await import('../src/components/thread/items/StepGroups.tsx');

const PNG = (n: string) => `data:image/png;base64,${n}`;
let seq = 0;
// a Codex code-mode program's nested call, or a Claude Code / ACP desktop tool call: one finished item per action
const call = (tool: string, args: any, o: { status?: string; shot?: string; text?: string } = {}) => ({
  id: `exec-${++seq}`,
  type: 'mcpToolCall',
  server: 'sage_3e7a9e6bbbd3',
  tool,
  arguments: args,
  status: o.status ?? 'completed',
  result: {
    content: [
      ...(o.text ? [{ type: 'text', text: o.text }] : []),
      ...(o.shot ? [{ type: 'image', data: o.shot, mimeType: 'image/png' }] : []),
    ],
  },
});
const click = (i: number, o = {}) => call('desktop_app_click', { app: 'Calculator', element_index: i }, o);
const shot = (n: string) => call('desktop_app_screenshot', { app: 'Calculator' }, { shot: n });
const runText = (root: { $: (s: string) => Element | null }) => text(root.$('.control-run > .step-row.summary .step-text'));

for (const harness of ['codex', 'claude', 'acp:opencode']) {
  test(`${harness}: each finished desktop step joins the running group's run while the model thinks between calls`, async (t) => {
    const steps = [click(15), shot('one'), click(16, { status: 'failed', text: 'element changed' }), shot('two')];
    const update = (items: any[]) =>
      chat([turn('t1', [user('u', 'Compute 12 times 34'), ...items], { status: 'inProgress' })], { activeTurnId: 't1' });
    update(steps.slice(0, 1));
    setStore({ segments: { [T]: [{ nativeId: T, harness, start: 0 }] }, prefs: { showReasoning: true } });
    const v = await render(view());
    t.after(() => v.unmount());
    // one finished step: its own row, with the turn still running
    assert.equal(v.$('.control-run'), null);
    assert.equal(v.$$('.step-text').length, 1);
    // the row says what the run did so far, in Claude Desktop's words; a failure counts until a later step gets past it
    const said = [
      'Clicked, captured screen in Calculator',
      'Clicked 2 times (1 failed), captured screen in Calculator',
      'Clicked 2 times, captured screen 2 times in Calculator',
    ];
    for (let n = 2; n <= steps.length; n++) {
      await settle(() => update(steps.slice(0, n)));
      assert.equal(runText(v), said[n - 2], `${harness} after ${n} steps`);
    }
    // the latest screenshots end the run's row, as a settled run's do
    assert.deepEqual(
      v.$$('.control-run .step-thumbs > .step-thumb').map((i) => i.getAttribute('src')),
      [PNG('one'), PNG('two')],
    );
    // a call still running is the running line, not part of the run (the failure the turn got past is not counted)
    await settle(() => update([...steps, click(7, { status: 'inProgress' })]));
    assert.equal(runText(v), said[2]);
  });
}

for (const ux of ['dots', 'shimmer'] as const) {
  test(`${ux}: a running group shows its finished control steps; one with no control shows no run`, async (t) => {
    setStore({ prefs: { showReasoning: true } });
    const group = (items: any[]) => h(StepGroup, { items, cwd: '/repo', active: true, ux });
    const v = await render(group([click(1), shot('a')]));
    t.after(() => v.unmount());
    assert.equal(runText(v), 'Clicked, captured screen in Calculator');
    await v.rerender(group([click(1), shot('a'), click(2, { status: 'inProgress' })]));
    assert.equal(runText(v), 'Clicked, captured screen in Calculator');
    await v.rerender(group([call('sage_debug_echo', {}), call('sage_debug_echo', {})]));
    assert.equal(v.$('.control-run'), null);
    assert.equal(v.$('.step-text'), null);
  });
}
