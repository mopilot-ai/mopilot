// Copying text for the user: the clipboard write, then what confirms it (a toast or the button's own check), or a toast saying it failed.

import { native } from '../lib/native';
import { toast, toastFailure } from '../store/core';

/**
 * Copy `text` and confirm only once it is on the clipboard: `done` is the toast to show ("Copied chat ID"), or a
 * callback for a control that shows the confirmation itself. A failed write says so instead, then calls `failed`
 * (a control that confirms itself takes back an earlier check).
 */
export function copyText(text: string, done: string | (() => void), failed?: () => void): void {
  const notCopied = toastFailure("Couldn't copy");
  native.clipboard.write(text).then(
    () => (typeof done === 'string' ? toast(done) : done()),
    (error) => {
      notCopied(error);
      failed?.();
    },
  );
}
