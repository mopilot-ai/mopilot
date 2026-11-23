// A diff's added and removed rows are tinted in light and dark mode, with text that stays readable on the tint and the +/− and underline/strike marks kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
const reviewPath = '../mobile/src/screens/Review';
const themePath = '../mobile/src/theme';
const { Review } = await import(reviewPath);
const { themes: palettes } = await import(themePath);

/** WCAG 2.x relative luminance contrast of two #rrggbb colours. */
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('text on an added or removed row has at least AA contrast in both colour schemes, and the two tints differ from each other and the page', () => {
  for (const scheme of ['light', 'dark'] as const) {
    const p = palettes[scheme];
    for (const tint of [p.addBg, p.delBg]) {
      assert.ok(contrast(p.ink, tint) >= 4.5, `${scheme} ${tint} ink ${contrast(p.ink, tint).toFixed(2)}`);
      assert.ok(contrast(p.ink2, tint) >= 4.5, `${scheme} ${tint} muted ${contrast(p.ink2, tint).toFixed(2)}`);
      assert.notEqual(tint, p.bg);
      assert.notEqual(tint, p.surface);
    }
    assert.notEqual(p.addBg, p.delBg);
  }
});

const rows = [
  { k: 'hunk', t: '@@ -9,2 +9,2 @@' },
  { k: 'ctx', t: 'keep' },
  { k: 'del', t: 'const a = 1;', w: [10, 11] },
  { k: 'add', t: 'const a = 2;', w: [10, 11] },
  { k: 'meta', t: 'No newline at end of file' },
];

for (const dark of [false, true]) {
  test(`added and removed rows carry their tint and keep their marks (${dark ? 'dark' : 'light'})`, async () => {
    (globalThis as any).__phoneDark = dark;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      const { runtime } = scripted((m) =>
        m === 'diff.list'
          ? { files: [{ path: 'a.ts', status: 'modified', add: 1, del: 1 }] }
          : m === 'diff.read'
            ? { binary: false, rows, next: null, total: 5 }
            : undefined,
      );
      await act(async () => root.render(createElement(Review, { runtime, chatId: 'c', back: () => {} })));
      await flush();
      await act(async () => (host.querySelector('button[aria-label^="View diff"]') as HTMLElement).click());
      await flush();
      // an added or removed row says so to a screen reader and carries its tint; context and hunk rows have none
      const row = (label: string) => host.querySelector(`[aria-label^="${label}"]`) as HTMLElement;
      const p = palettes[dark ? 'dark' : 'light'];
      const bg = (el: HTMLElement) => JSON.parse(el.dataset.style!).backgroundColor;
      assert.equal(bg(row('Added, line 10: const a = 2;')), p.addBg);
      assert.equal(bg(row('Removed, line 10: const a = 1;')), p.delBg);
      const keep = [...host.querySelectorAll('[data-style]')].find((n) => n.textContent === '9keep')!;
      assert.equal(JSON.parse((keep as HTMLElement).dataset.style!).backgroundColor, undefined);
      // the sign is text, so colour is never the only cue
      assert.match(host.textContent!, /\+const a = 2;/);
      assert.match(host.textContent!, /−const a = 1;/);
    } finally {
      delete (globalThis as any).__phoneDark;
      await act(async () => root.unmount());
      host.remove();
    }
  });
}
