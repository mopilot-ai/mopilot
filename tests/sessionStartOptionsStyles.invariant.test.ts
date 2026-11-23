// Session start options owns an opaque themed surface and intrinsic select fields inside its positioned portal.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './support/dom.ts';
import { appCss } from './support/app-css.ts';

export const GUARDS = ['src/styles/'];

const style = document.createElement('style');
style.textContent = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8') + appCss();
before(() => document.head.append(style));
after(() => style.remove());

for (const theme of ['light', 'dark']) {
  for (const size of [14, 24]) {
    test(`start options owns its ${theme} surface and field styles at font ${size}`, () => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.setProperty('--fs-chat', `${size}px`);
      const portal = document.createElement('div');
      portal.className = 'popover-layer';
      portal.innerHTML =
        '<div class="session-start-options-popover" role="dialog" aria-label="Session start options"><div class="start-options"><label class="start-option">Harness<select><option>As proposed</option></select></label><label class="start-option">Model<select><option>A long external model name</option></select></label><label class="start-option">Effort<select><option>High</option></select></label><label class="start-option">Permissions<select><option>Ask for approval</option></select></label></div></div>';
      document.body.append(portal);
      try {
        const popup = getComputedStyle(portal.querySelector('[role="dialog"]')!);
        assert.equal(popup.backgroundColor, theme === 'light' ? '#ffffff' : '#22252c', 'the popup covers content underneath it');
        assert.equal(popup.borderTopWidth, '1px', 'the surface has a visible outline');
        assert.equal(popup.borderTopStyle, 'solid');
        assert.notEqual(popup.borderTopColor, 'transparent');
        assert.equal(popup.borderRadius, '12px');
        assert.ok(popup.boxShadow && popup.boxShadow !== 'none', 'the surface is raised above its anchor');
        assert.equal(popup.overflow, 'auto', 'large font and narrow viewport keep the last field reachable');
        for (const select of portal.querySelectorAll('select')) {
          const field = getComputedStyle(select);
          const label = getComputedStyle(select.parentElement!);
          assert.equal(
            field.backgroundColor,
            theme === 'light' ? '#e4e6e9' : '#2d3036',
            'native fields do not retain a mismatched system surface',
          );
          assert.equal(field.color, theme === 'light' ? '#181e2a' : '#eef1f6');
          assert.equal(field.appearance, 'none', 'the themed arrow replaces the platform-specific select decoration');
          assert.equal(field.borderTopStyle, 'solid');
          assert.ok(Number.parseFloat(field.borderTopWidth) > 0);
          assert.equal(field.fontFamily, label.fontFamily);
          assert.equal(field.fontSize, label.fontSize);
          assert.ok(field.height === '' || field.height === 'auto', 'font24 fields grow with their line box');
          assert.equal(field.minHeight, '28px');
          assert.equal(field.minWidth, '0', 'an external model label can shrink within its row');
          assert.ok(field.backgroundImage.includes('linear-gradient'), 'removing native appearance keeps an explicit dropdown affordance');
        }
      } finally {
        portal.remove();
        document.documentElement.removeAttribute('data-theme');
        document.documentElement.style.removeProperty('--fs-chat');
      }
    });
  }
}
