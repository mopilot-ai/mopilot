// Screenshot thumbnails open their image directly without consuming a step or group disclosure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { createElement as h } from 'react';
import { render, settle } from './support/thread-kit.ts';
import { controlNarrationFixture } from './support/control-narration-kit.ts';

const fixture = await controlNarrationFixture({ realImages: true });
const { StepRow } = await import('../src/components/thread/items/StepRow.tsx');
const { StepGroup } = await import('../src/components/thread/Items.tsx');
const shot = (id: string) => ({
  id,
  type: 'mcpToolCall',
  server: 'sage',
  tool: 'browser_computer',
  arguments: { action: 'screenshot' },
  status: 'completed',
  result: { content: [{ type: 'image', data: id, mimeType: 'image/png' }] },
});

for (const kind of ['step', 'control run', 'mixed group']) {
  test(`${kind}: each trailing thumbnail opens on the first click and preserves disclosure state`, async () => {
    fixture.state = { prefs: { showReasoning: true } };
    const a = shot('first');
    const b = shot('second');
    const items =
      kind === 'mixed group' ? [a, b, { id: 'other', type: 'mcpToolCall', tool: 'sage_debug_echo', status: 'completed' }] : [a, b];
    const v = await render(
      kind === 'step'
        ? h(StepRow, { step: { kind: 'tool', item: a } as any, cwd: '/repo' })
        : h(StepGroup, { items: items as any, cwd: '/repo', active: false }),
    );
    const row = v.$('.step-row')!;
    const toggle = () => row.querySelector<HTMLButtonElement>('.step-row-hit')!;
    const thumbnails = [...row.querySelectorAll<HTMLElement>('.step-thumb')];
    assert.ok(thumbnails.length);
    assert.equal(row.querySelector('button button, button [role="button"]'), null);
    for (const expanded of [false, true]) {
      if (expanded) await settle(() => toggle().click());
      for (const thumbnail of thumbnails) {
        thumbnail.focus();
        await settle(() => thumbnail.click());
        assert.equal(document.querySelector('.lightbox-image')?.getAttribute('src'), thumbnail.getAttribute('src'));
        assert.equal(toggle().getAttribute('aria-expanded'), String(expanded));
        await settle(() => (document.querySelector('.lightbox-close') as HTMLElement).click());
        assert.equal(document.querySelector('.lightbox'), null);
        assert.equal(document.activeElement === thumbnail, true);
        for (const key of ['Enter', ' ']) {
          await settle(() =>
            thumbnail.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }) as unknown as Event),
          );
          assert.ok(document.querySelector('.lightbox'));
          assert.equal(toggle().getAttribute('aria-expanded'), String(expanded));
          await settle(() => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })));
        }
      }
    }
    await v.unmount();
    assert.equal(document.querySelector('.lightbox'), null);
  });
}

test('native Codex, native Claude and ACP control images share the direct preview, including retirement', async () => {
  const native = [
    { ...shot('codex'), server: 'cua_repl', tool: 'js', arguments: { code: 'await tab.screenshot();' } },
    { ...shot('claude'), server: 'claude-in-chrome', tool: 'computer' },
    { ...shot('acp'), tool: 'desktop_app_screenshot', arguments: { app: 'Notes' } },
  ];
  const v = await render(h(StepRow, { step: { kind: 'tool', item: native[0] } as any, cwd: '/repo' }));
  for (const item of native) {
    await v.rerender(h(StepRow, { step: { kind: 'tool', item } as any, cwd: '/repo' }));
    await settle(() => v.$('.step-thumb')!.click());
    assert.equal(document.querySelector('.lightbox-image')?.getAttribute('src'), `data:image/png;base64,${item.id}`);
    // Retiring the visible screenshot also retires its portalled preview.
    await v.rerender(h('div'));
    assert.equal(document.querySelector('.lightbox'), null);
  }
  await v.unmount();
});
