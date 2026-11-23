// Integrated queue tray styles keep its attached frame, readable rows and action targets at every chat font size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { appCss } from './support/app-css.ts';
import { readFileSync } from 'node:fs';

test('the queue shares the composer width and radius instead of a second inset frame', () => {
  const style = document.createElement('style');
  style.textContent = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8') + appCss();
  document.head.append(style);
  const host = document.createElement('div');
  host.innerHTML = `<div class="composer-wrap" data-theme="dark"><div class="queue-tray"><div class="queue-list"><div class="queue-row">
    <svg class="queue-icon"></svg><button class="queue-text">A long queued message</button>
    <div class="queue-actions"><span class="tooltip-anchor"><button class="queue-steer">Steer</button></span><button class="icon-btn xs">Remove</button></div>
    </div></div></div><div class="composer"></div></div>`;
  document.body.append(host);
  try {
    const tray = host.querySelector<HTMLElement>('.queue-tray')!;
    const composer = host.querySelector('.composer')!;
    const row = host.querySelector('.queue-row')!;
    const actions = host.querySelector('.queue-actions')!;
    assert.equal(getComputedStyle(tray).marginLeft, '0px');
    assert.equal(getComputedStyle(tray).marginRight, '0px');
    assert.equal(getComputedStyle(tray).borderTopLeftRadius, getComputedStyle(composer).borderTopLeftRadius);
    assert.equal(getComputedStyle(tray).borderTopRightRadius, getComputedStyle(composer).borderTopRightRadius);
    assert.equal(getComputedStyle(row).alignItems, 'center');
    assert.equal(getComputedStyle(row).flexShrink, '0', 'a long queue scrolls instead of compressing rows');
    assert.equal(getComputedStyle(actions).flexShrink, '0', 'actions cannot squeeze or cover the queued text');
    assert.equal(getComputedStyle(host.querySelector('.queue-text')!).textAlign, 'left');
    for (const size of [14, 24]) {
      host.style.setProperty('--fs-chat', `${size}px`);
      assert.equal(getComputedStyle(row).fontSize, `${size}px`);
      assert.equal(getComputedStyle(host.querySelector('.queue-text')!).textOverflow, 'ellipsis');
    }
    const detached = tray.cloneNode(true) as HTMLElement;
    const standalone = document.createElement('div');
    standalone.className = 'thread-composer-area';
    standalone.append(detached);
    host.append(standalone);
    assert.ok(
      !['', 'auto'].includes(getComputedStyle(detached).width),
      'a standalone queue has an explicit width inside its centered flex parent',
    );
    assert.notEqual(getComputedStyle(detached).borderBottomStyle, 'none', 'a queue without a composer keeps its complete frame');
  } finally {
    host.remove();
    style.remove();
  }
});
