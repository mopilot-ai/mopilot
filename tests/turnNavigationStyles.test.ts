import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { appCss } from './support/app-css.ts';
import { paletteToken } from './support/palette.ts';
import { defined } from './support/defined.ts';

const styles = [readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8'), appCss()].join('\n');

// Codex's rail: each mark is a 2px line 26px long that scales from the left, 6px at rest. The hovered (or scrubbed)
// mark grows to full length, its neighbors to 70/40/20% (data-neighbor-distance). Every turn on screen is current and
// is marked by color, which it gives up while another mark is hovered; a bookmark adds a dot and full opacity.
const scale = (progress: string) => `scaleX(calc(.2308 + .7692 * ${progress}))`;
const marks = (list: string) => `<nav class="turn-navigation"><div class="turn-navigation-list">${list}</div></nav>`;
const mark = (classes = '', attributes = '', bookmarked = false) =>
  `<button class="turn-navigation-mark ${classes}" ${attributes}><span class="turn-navigation-marker"><span class="turn-navigation-marker-line"></span>${
    bookmarked ? '<span class="turn-navigation-bookmark-dot"></span>' : ''
  }</span></button>`;

for (const theme of ['light', 'dark']) {
  test(`${theme}: marks keep Codex's geometry at rest; hover and its neighbors scale them, and current and bookmark keep their colors`, async () => {
    const window = new Window();
    try {
      const document = window.document;
      document.documentElement.setAttribute('data-theme', theme);
      const style = document.createElement('style');
      style.textContent = styles;
      document.head.append(style);
      const render = (list: string) => {
        document.body.innerHTML = marks(list);
        return [...document.querySelectorAll('.turn-navigation-marker')].map((marker) => ({
          marker: window.getComputedStyle(marker),
          line: window.getComputedStyle(marker.firstElementChild!),
        }));
      };
      const rest = paletteToken(theme, '--text-3');
      const strong = paletteToken(theme, '--text');

      const button = (() => {
        render(mark());
        return window.getComputedStyle(document.querySelector('.turn-navigation-mark')!);
      })();
      assert.equal(button.width, '36px');
      assert.equal(button.height, '10px');

      // at rest: equal length; the current mark stands out by color only, a bookmark by opacity and its dot
      const idle = render(mark() + mark('current') + mark('bookmarked', '', true));
      assert.deepEqual(
        idle.map((m) => [m.marker.width, m.marker.height]),
        Array(3).fill(['26px', '2px']),
      );
      assert.deepEqual(
        idle.map((m) => m.line.transform),
        Array(3).fill(scale('0')),
      );
      assert.equal(idle[0].marker.color, rest);
      assert.equal(idle[0].marker.opacity, '.4');
      assert.equal(idle[1].marker.color, strong);
      assert.equal(idle[1].marker.opacity, '.6');
      assert.equal(idle[2].marker.opacity, '1');
      assert.equal(window.getComputedStyle(document.querySelector('.turn-navigation-bookmark-dot')!).width, '2px');

      // hovering: the hovered mark at full length, its neighbors at 70/40/20%, and the current mark yields
      const hover = render(
        mark('', 'data-neighbor-distance="3"') +
          mark('', 'data-neighbor-distance="2"') +
          mark('current', 'data-neighbor-distance="1"') +
          mark('hovered') +
          mark('current hovered'),
      );
      assert.deepEqual(
        hover.map((m) => m.line.transform),
        [scale('.2'), scale('.4'), scale('.7'), scale('1'), scale('1')],
      );
      assert.equal(hover[2].marker.color, rest);
      assert.equal(hover[2].marker.opacity, '.4');
      assert.equal(hover[3].marker.color, strong);
      assert.equal(hover[3].marker.opacity, '1');
      assert.equal(hover[4].marker.color, strong);
    } finally {
      await window.happyDOM.close();
    }
  });
}

test('file lists scroll within a bounded card while pagination and collapse stay outside', async () => {
  const window = new Window();
  try {
    const style = window.document.createElement('style');
    style.textContent = styles;
    window.document.head.append(style);
    window.document.body.innerHTML =
      '<div class="edited-files"><div class="edited-file-list"></div><div class="edited-pagination"></div><button class="edited-expand">Show less</button></div>';
    const list = window.document.querySelector('.edited-file-list')!;
    const computed = window.getComputedStyle(list);
    assert.equal(computed.maxHeight, '360px');
    assert.equal(computed.overflowY, 'auto');
    assert.equal(list.contains(defined(window.document.querySelector('.edited-expand'))), false);
    assert.equal(list.contains(defined(window.document.querySelector('.edited-pagination'))), false);
  } finally {
    await window.happyDOM.close();
  }
});
