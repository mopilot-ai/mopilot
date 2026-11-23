// The extension's microphone page (mic.html): Chrome can't ask for the microphone inside the side panel, so Dictate (panelDictate.mjs) opens this page, where Chrome asks once for the extension; the side panel can record from then on.

/** What the page says after Chrome answers. */
export const MIC_LINES = Object.freeze({
  allowed: 'Microphone allowed. Close this tab and dictate in the side panel.',
  blocked: 'Chrome blocked the microphone. Allow it for MoPilot in Chrome’s site settings, then try again.',
  missing: 'No microphone found.',
});

/** Starts the page in its window (`g`: document, navigator). */
export function startMicPage(/** @type {any} */ g) {
  const $ = (/** @type {string} */ id) => g.document.getElementById(id);
  async function ask() {
    try {
      const stream = await g.navigator.mediaDevices.getUserMedia({ audio: true });
      // allowed: nothing is recorded here
      for (const t of stream.getTracks()) t.stop();
      $('line').textContent = MIC_LINES.allowed;
      $('allow').hidden = true;
    } catch (e) {
      const name = /** @type {Error} */ (e)?.name;
      $('line').textContent =
        name === 'NotFoundError'
          ? MIC_LINES.missing
          : name === 'NotAllowedError'
            ? MIC_LINES.blocked
            : String(/** @type {Error} */ (e)?.message ?? e);
    }
  }
  $('allow').addEventListener('click', () => void ask());
  // opened from the side panel's mic: ask at once
  return ask();
}
