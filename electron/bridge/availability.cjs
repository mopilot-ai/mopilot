// window.native.availability: which native browser and computer control each harness gets on this Mac, and Claude in Chrome's live links (electron/capabilities/nativeAvailability.cjs, electron/harness/claude/chromeLink.cjs).
const { invoke, on } = require('./spec.cjs');

module.exports = {
  status: invoke('availability:status', (refresh) => [refresh === true]),
  onChanged: on('availability:changed'),
  retry: invoke('availability:retry'),
  // Claude in Chrome's live connection in each Claude Code session (electron/harness/claude/chromeLink.cjs)
  chromeLinks: invoke('claude:chromeLinks', (refresh) => [refresh === true]),
  onChromeLinksChanged: on('claude:chromeLinksChanged'),
  chromeReconnect: invoke('claude:chromeReconnect', (chatId) => [chatId ?? null]),
  chromeBrowsers: invoke('claude:chromeBrowsers'),
  chromeSelect: invoke('claude:chromeSelect', 1),
  // MoPilot's own Chrome extension: Settings → Browser's Pair (#1632)
  chromePair: invoke('availability:chromePair'),
  // "Allow Chrome to connect?" answered: only a real true allows
  chromeAllow: invoke('availability:chromeAllow', (allow, name) => [allow === true, name]),
  chromeInstall: invoke('availability:chromeInstall'),
};
