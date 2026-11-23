// The app's Claude Code harness: the one in main, with the app's side of what the harness takes from ports. The browser layer's hand-off check (a page handed to the user's Chrome for a sign-in) goes in too. Links shared modules open go to main's guarded shell (the scratch-Chrome guard, capabilities/browser/userChrome.cjs, #1535), through the openExternal port.
const { createClaudeHarness: create } = require('../harness/claude/index.cjs');
const { installOpenExternal } = require('../platform/ports/openExternal.cjs');
const { handedOff } = require('../capabilities/browser/handoffPages.cjs');

/** @param {{ shell: { openExternal: (url: string, ...options: any[]) => any }, preferHighestCli: () => boolean }} o */
function createClaudeHarness({ shell, preferHighestCli }) {
  installOpenExternal((url, ...options) => shell.openExternal(url, ...options));
  return create({ handedOff, preferHighestCli });
}

module.exports = { createClaudeHarness };
