// Shared bench Settings exit: shortcut text is a separate line, not part of the Back to app label.
/** @param {{querySelectorAll: (selector: string) => Iterable<{innerText?: string, click: () => void}>}} document */
export function backButton(document) {
  return [...document.querySelectorAll('button')].find((b) => (b.innerText ?? '').split('\n')[0].trim() === 'Back to app');
}
export const BACK_BUTTON = `(${backButton.toString()})(document)`;
export const BACK_TO_APP = `${BACK_BUTTON}?.click()`;
