// Model Chromium's hidden-popover focus boundary, which happy-dom otherwise accepts.
import type { TestContext } from 'node:test';

export function browserPopoverFocus(t: TestContext) {
  const original = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
    if (this.closest<HTMLElement>('.popover-layer')?.style.visibility === 'hidden') return;
    original.call(this, options);
  };
  t.after(() => {
    HTMLElement.prototype.focus = original;
  });
}
