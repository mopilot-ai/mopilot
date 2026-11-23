// Tool screenshots and browser/desktop step presentation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, f, StepRow, StepGroup, summarizeSteps, activeStepLabel, mount } from './fixture';

export function registerToolPresentationCases() {
  /* ------------------------------ Items: ToolIO ------------------------------ */

  async function toolStep(item: any) {
    const m = await mount(
      createElement(StepRow, {
        step: { kind: 'tool', item: { type: 'mcpToolCall', server: 'browser', tool: 'screenshot', arguments: { tab: 1 }, ...item } },
        cwd: '/project',
      }),
    );
    await m.click(m.host.querySelector('.step-row-hit, button.step-row'));
    return m;
  }

  test('tool image blocks render as zoomable screenshots next to the text output', async () => {
    const m = await toolStep({
      result: {
        content: [
          { type: 'text', text: 'Captured' },
          { type: 'image', data: 'AAA', mimeType: 'image/png' },
          { type: 'image', data: 'BBB', mimeType: 'image/jpeg' },
        ],
      },
    });
    try {
      const previews = m.host.querySelector('.tool-previews')!;
      assert.equal(previews.getAttribute('aria-label'), 'Screenshots');
      assert.deepEqual(
        [...previews.querySelectorAll('img')].map((i: any) => [i.className, i.getAttribute('src'), i.getAttribute('alt')]),
        [
          ['tool-screenshot', 'data:image/png;base64,AAA', 'Tool screenshot 1'],
          ['tool-screenshot', 'data:image/jpeg;base64,BBB', 'Tool screenshot 2'],
        ],
      );
      const blocks = [...m.host.querySelectorAll('pre')].map((p: any) => [p.getAttribute('data-lang'), p.textContent]);
      assert.deepEqual(blocks, [
        ['json', '{\n  "tab": 1\n}'],
        ['text', 'Captured'],
      ]);
      assert.ok(!m.host.textContent!.includes('AAA'));
    } finally {
      await m.close();
    }
  });

  test('tool output without images has no screenshot strip', async () => {
    const m = await toolStep({ result: { content: [{ type: 'text', text: 'plain' }] } });
    try {
      assert.equal(m.host.querySelector('.tool-previews') === null, true);
      assert.deepEqual(
        [...m.host.querySelectorAll('pre')].map((p: any) => p.textContent),
        ['{\n  "tab": 1\n}', 'plain'],
      );
    } finally {
      await m.close();
    }
  });

  /* ------------------------------ Items: browser and desktop control steps ------------------------------ */

  const PNG_URL = (d: string) => ({ type: 'image', data: d, mimeType: 'image/png' });
  const browserCall = (o: any = {}) => ({
    type: 'mcpToolCall',
    id: o.id ?? 'b1',
    server: 'sage',
    tool: 'browser_navigate',
    arguments: { url: 'https://example.com/a' },
    status: 'completed',
    result: { content: o.images ?? [] },
    ...o.item,
  });
  const desktopCall = (o: any = {}) => ({
    type: 'mcpToolCall',
    id: o.id ?? 'd1',
    server: 'sage',
    tool: 'desktop_open_application',
    arguments: { app: 'Notes' },
    status: 'completed',
    result: { content: o.images ?? [] },
    ...o.item,
  });
  const otherCall = (o: any = {}) => ({
    type: 'mcpToolCall',
    id: o.id ?? 'o1',
    server: 'docs',
    tool: 'search',
    arguments: {},
    status: 'completed',
    result: { content: [] },
    ...o,
  });

  test('a group of steps names browser and desktop control by what they did, apart from other tools', () => {
    const steps = (items: any[]) => items.map((item) => ({ kind: 'tool' as const, item }));
    assert.deepEqual(summarizeSteps(steps([browserCall(), browserCall({ id: 'b2' }), desktopCall(), otherCall()])), {
      text: 'Opened 2 times, opened app, called a tool',
      icon: 'web',
    });
    assert.deepEqual(summarizeSteps(steps([desktopCall()])), { text: 'Opened app', icon: 'tool' });
    assert.deepEqual(summarizeSteps(steps([otherCall(), otherCall({ id: 'o2' })])), { text: 'Called 2 tools', icon: 'tool' });
    assert.deepEqual(summarizeSteps([{ kind: 'reasoning', item: { summary: [] } }, ...steps([browserCall()])] as any), {
      // a group with control names no thinking, as Claude Desktop's summary
      text: 'Opened',
      icon: 'web',
    });
  });

  test('the running step says what browser or desktop control is doing; other tools say which tool', () => {
    assert.equal(activeStepLabel({ kind: 'tool', item: browserCall({ item: { status: 'inProgress' } }) } as any), 'Opening example.com');
    assert.equal(activeStepLabel({ kind: 'tool', item: desktopCall() } as any), 'Opening Notes');
    assert.equal(activeStepLabel({ kind: 'tool', item: otherCall() } as any), 'Calling search');
    assert.equal(activeStepLabel(undefined), 'Thinking');
  });

  async function group(items: any[], props: any = {}) {
    f.state = { prefs: { showReasoning: true } };
    return mount(createElement(StepGroup, { items, cwd: '/project', active: false, ...props }));
  }

  test("a finished control step reads as what it did, with its screenshot and its surface's icon", async () => {
    for (const [item, text, icon] of [
      [browserCall({ images: [PNG_URL('AAA'), PNG_URL('BBB')] }), 'Opened example.com', 'globe'],
      [desktopCall(), 'Opened Notes', 'mouse'],
    ] as const) {
      const m = await mount(createElement(StepRow, { step: { kind: 'tool', item }, cwd: '/project' }));
      try {
        const row = m.host.querySelector('.step-row')!;
        assert.equal(row.querySelector('.step-text')!.textContent, text);
        assert.equal(row.querySelector('.step-icon [data-icon]')!.getAttribute('data-icon'), icon);
        const thumb = row.querySelector('.step-thumb');
        assert.equal(
          thumb?.getAttribute('src') ?? null,
          item.result.content.length ? 'data:image/png;base64,BBB' : null,
          'the last screenshot, or none',
        );
        // still expandable to its input and output
        await m.click(row.querySelector('.step-row-hit'));
        assert.ok(m.host.querySelector('.shell-box'));
      } finally {
        await m.close();
      }
    }
    // any other tool keeps "Called <server> <tool>" and the plug icon
    const m = await mount(createElement(StepRow, { step: { kind: 'tool', item: otherCall({ durationMs: 0 }) }, cwd: '/project' }));
    try {
      assert.equal(m.host.querySelector('.step-text')!.textContent, 'Called docs search');
      assert.equal(m.host.querySelector('.step-icon [data-icon]')!.getAttribute('data-icon'), 'plug');
      assert.equal(m.host.querySelector('.step-thumb') === null, true);
    } finally {
      await m.close();
    }
  });

  test('a collapsed group shows its last control screenshots at its end; one without a screenshot shows none', async () => {
    let m = await group([
      browserCall({ id: 'b1', images: [PNG_URL('OLD')] }),
      otherCall(),
      desktopCall({ id: 'd1', images: [PNG_URL('NEW')] }),
      desktopCall({ id: 'd2' }),
    ]);
    try {
      const summary = m.host.querySelector('.step-row.summary')!;
      assert.equal(summary.querySelector('.step-text')!.textContent, 'Opened, opened app 2 times, called a tool');
      assert.deepEqual(
        [...summary.querySelectorAll('.step-thumbs > .step-thumb')].map((i) => i.getAttribute('src')),
        ['data:image/png;base64,OLD', 'data:image/png;base64,NEW'],
      );
      await m.click(summary.querySelector('.step-row-hit')!);
      // the two desktop steps in a row are one run of their own
      assert.equal(m.host.querySelectorAll('.step-list > .step').length, 3);
      assert.equal(m.host.querySelector('.control-run .step-text')!.textContent, 'Opened app 2 times in Notes');
    } finally {
      await m.close();
    }
    m = await group([otherCall(), otherCall({ id: 'o2' })]);
    try {
      assert.equal(m.host.querySelector('.step-thumb') === null, true);
    } finally {
      await m.close();
    }
    // only the last three screenshots show, and the same picture twice shows once
    m = await group([
      browserCall({ id: 'k1', images: [PNG_URL('AAA')] }),
      browserCall({ id: 'k2', images: [PNG_URL('BBB')] }),
      browserCall({ id: 'k3', images: [PNG_URL('CCC')] }),
    ]);
    try {
      const srcs = [...m.host.querySelectorAll('.step-row.summary .step-thumb')].map((i) => i.getAttribute('src'));
      assert.deepEqual(srcs, ['data:image/png;base64,AAA', 'data:image/png;base64,BBB', 'data:image/png;base64,CCC']);
    } finally {
      await m.close();
    }
    m = await group([browserCall({ id: 's1', images: [PNG_URL('SSS')] }), browserCall({ id: 's2', images: [PNG_URL('SSS')] })]);
    try {
      assert.equal(m.host.querySelectorAll('.step-row.summary .step-thumb').length, 1);
    } finally {
      await m.close();
    }
    // one step is its own row; no steps, nothing
    m = await group([desktopCall()]);
    try {
      assert.equal(m.host.querySelector('.step-row.summary') === null, true);
      assert.equal(m.host.querySelector('.step-text')!.textContent, 'Opened Notes');
    } finally {
      await m.close();
    }
    m = await group([]);
    try {
      assert.equal(m.host.innerHTML, '');
    } finally {
      await m.close();
    }
  });

  test('while a turn runs, the Claude activity line says what browser or desktop control is doing', async () => {
    const running = (item: any) => ({ ...item, status: 'inProgress' });
    let m = await group([otherCall(), running(browserCall())], { active: true, ux: 'dots' });
    try {
      assert.equal(m.host.querySelector('[data-marker="claude-activity"]')!.textContent, 'Opening example.com');
    } finally {
      await m.close();
    }
    // any other running tool, a finished last step, or a running command keep the harness's own label
    m = await group([running(otherCall())], { active: true, ux: 'dots' });
    try {
      assert.equal(m.host.querySelector('[data-marker="claude-activity"]')!.textContent, 'Claude: tool');
    } finally {
      await m.close();
    }
    m = await group([browserCall()], { active: true, ux: 'dots' });
    try {
      // a finished last step: the line keeps its words while the model goes on, as Claude Desktop's row does
      assert.equal(m.host.querySelector('[data-marker="claude-activity"]')!.textContent, 'Opening example.com');
    } finally {
      await m.close();
    }
    m = await group([{ type: 'commandExecution', id: 'c1', command: 'npm test', status: 'inProgress', aggregatedOutput: 'ok' }], {
      active: true,
      ux: 'dots',
    });
    try {
      const activity = m.host.querySelector('[data-marker="claude-activity"]')! as any;
      assert.match(activity.textContent, /^Claude: command/);
      assert.equal(activity.getAttribute('data-open'), 'false');
      await m.click(activity);
      assert.equal(m.host.querySelector('[data-marker="claude-activity"]')!.getAttribute('data-open'), 'true');
      // a second click closes the live output again
      await m.click(m.host.querySelector('[data-marker="claude-activity"]')!);
      assert.equal(m.host.querySelector('[data-marker="claude-activity"]')!.getAttribute('data-open'), 'false');
    } finally {
      await m.close();
    }
    // the shimmer row uses the same label
    m = await group([running(desktopCall())], { active: true });
    try {
      assert.equal(m.host.querySelector('.step-row.active .shimmer')!.textContent, 'Opening Notes');
    } finally {
      await m.close();
    }
    m = await group([{ type: 'commandExecution', id: 'c1', command: 'npm test', status: 'inProgress' }], { active: true });
    try {
      assert.equal(m.host.querySelector('[data-marker="running-command"]')!.textContent, 'Running npm test');
    } finally {
      await m.close();
    }
  });
}
