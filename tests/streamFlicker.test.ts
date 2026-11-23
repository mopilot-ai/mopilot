// A streaming reply never flickers: what it shows keeps its DOM, and so its fade, as the rest arrives (streamCut.ts, Markdown.tsx).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, stubComponent, render, resetStore, impl } from './support/thread-kit.ts';

mockStore();
autoMock('src/session/open.ts', 'open');
autoMock('src/lib/highlight.ts', 'hl');
autoMock('src/components/ui/ImageLightbox.tsx', 'img', { ZoomableImage: stubComponent('ZoomableImage') });
autoMock('src/components/markdown/SkillLink.tsx', 'skill', { SkillLink: stubComponent('SkillLink') });
autoMock('src/components/markdown/Visualization.tsx', 'viz', { Visualization: stubComponent('Visualization') });
const { Markdown, runSteps, sameRunSteps, sourceSteps } = await import('../src/components/markdown/Markdown.tsx');
const { PACE } = await import('../src/lib/textPacer.ts');
const { revealCeiling, stepEnd } = await import('../src/lib/streamCut.ts');

beforeEach(() => {
  resetStore();
  impl['hl:highlight'] = () => new Promise(() => {});
});

/** Replies of the kinds models write, in Chinese and English: emphasis, code, links, lists, tables, math and fences. */
const REPLIES: Record<string, string> = {
  zh: '原因找到了：MoPilot 卡，主要**不是渲染慢**，而是吐字的`节奏策略`不一样。\n\n## 对比\n\n1. 第一点很重要\n2. 第二点也重要，见 [文档](https://example.com/a)\n\n| 环节 | 做法 |\n|---|---|\n| main | 16 ms 合并 |\n\n> 引用一句话，带 *斜体*。\n\n最后一段话，$$x^2$$ 结束。',
  en: 'The cause is **not rendering**, it is the `pacing` policy.\n\n- one item\n- [ ] a task with a [link](https://example.com)\n- two ~~old~~ items\n\nSee <https://example.com/docs> and https://example.com/raw.\n\n```ts\nconst x = **1**;\n```\n\nAfter code, an *italic* end &amp; more.',
  mixed: '### Steps\n\n1. Run `npm test`\n2. 打开 **设置** 页面\n   - nested _item_\n\nDone — 完成了！\n\n---\n\nFinal **bold** line.',
  hard: '**星宇(JX)**的方案，***粗斜体*** 和 __下划线粗体__，还有 `a | b`。\n\nUse `` code with ` tick `` and \\`escaped\\` ticks, an image ![logo](a.png "Title") and [link](https://x.y "t").\n\n10. ten\n11. eleven with **bold\n    across lines**\n\n> outer\n> > inner quote\n\nLine one  \nLine two. Price $10, math $$a+b$$.\n\n$$\n\\int_0^1 x\\,dx\n$$\n\nEnd.',
};

/** Elements that animate when they mount (thread-messages.css), and the inline elements that change form. */
const ANIMATED = '.fw, li, tr, blockquote, hr, .code-block, .md-table-wrap, strong, em, del, code, a, h2, h3, p, table';

/**
 * Stream `reply` into one view, `chunk` characters per delta, revealing it the way `reveal` decides after each
 * delta; returns every animated element with text that left the DOM while its text stayed on screen.
 */
async function stream(
  reply: string,
  reveal: (received: string, shown: number) => number,
  chunk = 8,
): Promise<{ lost: string[]; shown: number }> {
  const md = (text: string, streaming: boolean, steps: number[]) => h(Markdown, { text, cwd: '/repo', streaming, animate: true, steps });
  const steps: number[] = [];
  let shown = 0;
  const v = await render(md('', true, steps));
  let before = new Set<HTMLElement>();
  const lost: string[] = [];
  for (let received = chunk; received < reply.length + chunk; received += chunk) {
    const text = reply.slice(0, Math.min(received, reply.length));
    for (let next = reveal(text, shown); next > shown; next = reveal(text, shown)) {
      steps.push(shown);
      shown = next;
      await v.rerender(md(text.slice(0, shown), true, steps.slice()));
      const now = new Set(v.$$(ANIMATED));
      for (const el of before)
        if (!now.has(el) && el.textContent!.trim())
          lost.push(
            `<${el.tagName.toLowerCase()}> ${JSON.stringify(el.textContent)} at ${shown}${
              process.env.FLICK_DEBUG
                ? ` ${ANIMATED.split(', ')
                    .filter((q) => el.matches(q))
                    .join('/')} parent=${el.parentElement?.outerHTML.slice(0, 80)} | ${JSON.stringify(text.slice(shown - 15, shown))}`
                : ''
            }`,
          );
      before = now;
    }
  }
  await v.unmount();
  return { lost, shown };
}

/** The reveal as useSmoothText does it: steps of stepChars, each ending where its Markdown is complete. */
const paced = (received: string, shown: number) => stepEnd(received, shown, PACE.stepChars, revealCeiling(received));

for (const [name, reply] of Object.entries(REPLIES)) {
  test(`a ${name} reply revealed in safe steps never remounts what it shows, however its deltas are cut`, async () => {
    for (const chunk of [1, 3, 8, 17]) {
      const { lost, shown } = await stream(reply, paced, chunk);
      assert.deepEqual(lost, [], `${chunk} characters a delta`);
      // what waited for a construct to close shows once the reply finishes
      assert.ok(shown >= revealCeiling(reply) && shown <= reply.length);
    }
  });
}

test('the same replies revealed a character at a time do remount what they show (the flicker this prevents)', async () => {
  let remounts = 0;
  for (const reply of Object.values(REPLIES))
    remounts += (await stream(reply, (received, shown) => Math.min(received.length, shown + 1))).lost.length;
  assert.ok(remounts > 10, `${remounts} remounts`);
});

/** Markdown that only a later line decides (streamCut.ts): it still changes form, and mounts what it shows again. */
const LOOKAHEAD: Record<string, string> = {
  'a list turned loose': 'Steps:\n\n1. First\n\n   ```bash\n   npm ci\n   ```\n\n2. Second',
  'a setext heading': 'Setext heading\n===\n\nAfter.',
  'a table without outer pipes': 'a | b\n--|--\n1 | 2\n\nAfter.',
};
// (a footnote's section adds text of its own, its heading and back link, which fades in when it first appears)

for (const [name, reply] of Object.entries(LOOKAHEAD)) {
  test(`${name}: a word mounted again keeps the moment its fade began, so it carries on instead of restarting`, async () => {
    const md = (text: string, steps: number[], stepTimes: number[]) =>
      h(Markdown, { text, cwd: '/repo', streaming: true, animate: true, steps, stepTimes });
    const steps: number[] = [];
    const times: number[] = [];
    let shown = 0;
    let remounts = 0;
    const v = await render(md('', steps, times));
    // the same word may lose the whitespace after it as it changes form (a paragraph's `a ` becomes a cell's `a`)
    const moments = () => new Map(v.$$('.fw').map((el) => [el, `${el.textContent!.trim()}@${el.getAttribute('data-fade-at')}`]));
    let before = moments();
    try {
      for (let received = 1; received <= reply.length; received++) {
        const text = reply.slice(0, received);
        for (let next = paced(text, shown); next > shown; next = paced(text, shown)) {
          steps.push(shown);
          times.push(1000 + steps.length * 60);
          shown = next;
          await v.rerender(md(text.slice(0, shown), steps.slice(), times.slice()));
          const now = moments();
          const added = [...now].filter(([el]) => !before.has(el)).map(([, m]) => m);
          for (const [el, moment] of before) {
            const word = moment.slice(0, moment.lastIndexOf('@'));
            // a word that shows again (not syntax that went away, as a header's pipes do) keeps its moment
            const again = added.filter((m) => m.slice(0, m.lastIndexOf('@')) === word);
            if (now.has(el) || !again.length) continue;
            remounts++;
            assert.ok(again.includes(moment), `${moment} mounted again as ${again}`);
          }
          before = now;
        }
      }
      assert.ok(remounts > 0, 'this Markdown mounts what it shows again');
    } finally {
      await v.unmount();
    }
  });
}

test('every paced word names the moment its fade begins: its step time plus its stagger, kept as runs close', async () => {
  const md = (text: string, steps: number[], stepTimes: number[]) =>
    h(Markdown, { text, cwd: '/repo', streaming: true, animate: true, steps, stepTimes });
  const v = await render(md('First para.', [0, 6], [1000, 1100]));
  try {
    const at = () => v.$$('.fw').map((el) => [el.textContent, el.getAttribute('data-fade-at')]);
    assert.deepEqual(at(), [
      ['First ', '1000'],
      ['para.', '1100'],
    ]);
    // the paragraph closes into a run of its own: its words keep their moments
    await v.rerender(md('First para.\n\nSecond para.', [0, 6, 13], [1000, 1100, 1200]));
    assert.deepEqual(at(), [
      ['First ', '1000'],
      ['para.', '1100'],
      ['Second ', '1200'],
      ['para.', '1218'],
    ]);
  } finally {
    await v.unmount();
  }
});

test('fade spans follow the steps: each step a run of its own, words in a step waiting longer the later they come', async () => {
  const reply = 'First step words here. 第二步的中文文字。';
  const v = await render(h(Markdown, { text: reply, cwd: '/repo', streaming: true, animate: true, steps: [0, 23] }));
  try {
    const spans = v.$$('.fw').map((s) => [s.textContent, (s as HTMLElement).style.animationDelay || '0']);
    assert.deepEqual(spans, [
      ['First ', '0'],
      ['step ', '15ms'],
      ['words ', '27.5ms'],
      ['here. ', '42.5ms'],
      ['第二步的中文文字。', '0'],
    ]);
  } finally {
    await v.unmount();
  }
});

test("steps move with the source when directives or math rewrite the reply's text", () => {
  assert.deepEqual(sourceSteps([0, 5], 'same', 'same'), [0, 5]);
  assert.deepEqual(sourceSteps([], 'a', 'b'), []);
  // `\(x\)` becomes `$$x$$`: the source is two characters longer after the change
  const text = 'ab \\(x\\) cd ef';
  const source = 'ab $$x$$ cd ef';
  assert.deepEqual(sourceSteps([0, 3, 9, 40], text, source), [0, 3, 9, source.length]);
  assert.deepEqual(sourceSteps([12], 'abc', 'a'), [1]);
});

test("a run's steps are relative to its start, led by the step its text began in, each with its time", () => {
  assert.deepEqual(runSteps([0, 10, 30], [1, 2, 3], 0, 20), { steps: [0, 10], times: [1, 2] });
  assert.deepEqual(runSteps([0, 10, 30], [1, 2, 3], 15, 40), { steps: [-5, 15], times: [2, 3] });
  assert.deepEqual(runSteps([20], [5], 0, 10), { steps: [], times: [] });
  assert.deepEqual(runSteps([0], [], 0, 10), { steps: [0], times: [undefined] });
  // compared by value, so a closed run whose steps did not change keeps its render
  assert.equal(sameRunSteps(runSteps([0, 10], [1, 2], 0, 20), { steps: [0, 10], times: [1, 2] }), true);
  assert.equal(sameRunSteps({ steps: [0], times: [1] }, { steps: [0], times: [2] }), false);
  assert.equal(sameRunSteps({ steps: [0], times: [1] }, { steps: [0, 5], times: [1, 2] }), false);
});
