// CM-H20: long permission recovery text scrolls without displacing its retry or composer (src/styles/app/login.css).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { appCss } from './support/app-css.ts';

export const GUARDS = ['src/styles/'];

test('CM-H20: permission guidance has a viewport-relative scroll boundary; ordinary status text retains its layout', async () => {
  const limits: number[] = [];
  for (const height of [682, 1024]) {
    const window = new Window({ width: 1024, height });
    try {
      window.document.head.innerHTML = `<style>${appCss()}</style>`;
      for (const permission of [false, true]) {
        window.document.body.innerHTML = `<div class="thread-composer-area"><div class="composer-wrap"><div class="cu-guide ${permission ? 'cu-permission cu-onboarding' : ''}"><span>Icon</span><div class="cu-guide-text">${'Recovery instructions. '.repeat(100)}</div><button>Try again</button></div><div class="composer"><div class="composer-input">Draft</div></div></div></div>`;
        const text = window.document.querySelector('.cu-guide-text')!;
        const style = window.getComputedStyle(text);
        if (permission) {
          const boundary = Number.parseFloat(style.maxHeight);
          limits.push(boundary);
          assert.ok(
            boundary > 0 && boundary <= height / 2,
            'long recovery text must leave at least half the viewport for chat and composer',
          );
          assert.equal(style.overflowY, 'auto', 'every instruction remains reachable by scrolling');
          assert.equal(
            window.getComputedStyle(window.document.querySelector('.thread-composer-area')!).flexShrink,
            '1',
            'the card and draft share the available height',
          );
          assert.equal(
            window.getComputedStyle(window.document.querySelector('.composer-wrap')!).minHeight,
            '0',
            'a multiline draft cannot impose its intrinsic height on the thread',
          );
          assert.equal(style.minHeight, '0', 'instructions can shrink inside the card while retaining their scroll area');
          assert.equal(
            window.getComputedStyle(window.document.querySelector('button')!).maxHeight,
            '',
            'Try again stays outside the text scroller',
          );
        } else assert.equal(style.maxHeight, '', 'ordinary activity strips do not acquire a separate scroller');
      }
    } finally {
      await window.happyDOM.close();
    }
  }
  assert.ok(limits[1] > limits[0], 'the instructions can use more room in a taller window');
});
