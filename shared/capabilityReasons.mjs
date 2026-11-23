// User-facing capability-health reasons shared by every settings surface; diagnostic text is never presentation copy.
export const CAPABILITY_REASONS = Object.freeze({
  'computer.off': 'MoPilot turned computer use off for now. It comes back on its own; nothing to change here.',
  'computer.platform': 'Computer use needs macOS.',
  'computer.missing': 'Computer use is missing from this installation. Update or reinstall MoPilot.',
  'computer.build': 'Computer use isn’t available in this build.',
  'computer.start': 'Computer use couldn’t start. Try again.',
  'computer.accessibility': 'Allow Accessibility for MoPilot in System Settings.',
  'computer.screenRecording': 'Allow Screen Recording for MoPilot in System Settings.',
  'computer.unknown': 'Computer-use permissions will be checked when it starts.',
  'chrome.off': 'Your Chrome isn’t selected.',
  'chrome.tools': 'Your Chrome couldn’t start. Test its connection in Browser settings.',
  'chrome.extension': 'Install the Playwright Extension in Chrome.',
  'chrome.relayOff': 'MoPilot turned Chrome control off for now. It comes back on its own; use the built-in browser meanwhile.',
  'chrome.restart': 'Restart MoPilot to enable Chrome control.',
  'chrome.pair': 'Press Connect; if MoPilot then asks, click Allow in MoPilot.',
  'chrome.allow': 'Allow MoPilot to use this Chrome.',
  'chrome.connect': 'Open Chrome with the extension on.',
  'chrome.install': 'Add the MoPilot extension to Chrome.',
  'chrome.extensionOff': 'Turn it on in Chrome’s Extensions menu.',
  'native.off': 'MoPilot turned native control off for now. It comes back on its own; MoPilot’s own control works meanwhile.',
  'native.choice': 'Codex uses MoPilot’s computer use. Turn on Codex Computer Use below to use it instead.',
  'native.runtime': 'The native control plugin isn’t installed for this harness.',
  'native.platform': 'Native control is available only on macOS.',
  'native.surface': 'The installed plugin doesn’t enable this control surface.',
  'codex.chromeDisabled': 'Turn on ChatGPT for Chrome in Chrome’s Extensions settings.',
  'codex.chromeMissing': 'Install ChatGPT for Chrome to use native browser control.',
  'codex.installing': 'MoPilot is installing or updating Codex Computer Use.',
  'codex.installFailed': 'Codex Computer Use couldn’t be installed or updated. Try again.',
  'codex.missing': 'Codex Computer Use isn’t installed, and no copy is available to install.',
  'codex.incompatible': 'Codex Computer Use needs an update to work with the installed plugin.',
  'codex.waiting': 'Codex Computer Use will update when no loaded chat is using it.',
  'codex.permissions': 'Allow Accessibility and Screen Recording for Codex Computer Use in System Settings.',
  'claude.chromeDisabled': 'Turn on Claude in Chrome in Chrome’s Extensions settings.',
  'claude.chromeMissing': 'Install Claude in Chrome to use native browser control.',
  'claude.subscription': 'Claude in Chrome needs a claude.ai subscription login.',
  'tools.off': 'MoPilot turned its tools off for now. They come back on their own; nothing to change here.',
  'tools.bridge': 'MoPilot tools can’t connect right now. Restart MoPilot to try again.',
});

export const UNKNOWN_CAPABILITY_REASON = 'This feature needs attention. Open its settings to check.';

/** Unknown, absent and malformed codes never fall back to diagnostic text or inherited object properties. */
export function capabilityReasonText(/** @type {unknown} */ code) {
  return typeof code === 'string' && Object.hasOwn(CAPABILITY_REASONS, code)
    ? CAPABILITY_REASONS[/** @type {keyof typeof CAPABILITY_REASONS} */ (code)]
    : UNKNOWN_CAPABILITY_REASON;
}
