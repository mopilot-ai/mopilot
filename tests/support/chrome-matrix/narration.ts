// narration browser control matrix cases using shared fake surfaces.
import { test, assert, skyProblemOfItem } from './fixture.ts';

export function registerNarration() {
  /* ====================================================================== */
  /* Browser use: Sky and plugin stop messages (CM-B10)                      */
  /* ====================================================================== */

  // Wordings read from the installed Codex Computer Use (~/.codex/computer-use/Codex Computer Use.app,
  // Contents/MacOS/SkyComputerUseService, `strings`), the service behind the unified-computer-use plugin's cua_repl.
  const cuaItem = (text: string, status = 'completed') => ({
    type: 'mcpToolCall',
    server: 'cua_repl',
    tool: 'js',
    status,
    result: { content: [{ type: 'text', text }] },
  });

  test('CM-B10a: the Sky wordings MoPilot knows still map to their states as the installed service words them', () => {
    const cases: [string, string][] = [
      ['Computer Use permissions are not granted', 'permissions'],
      [
        'Computer Use permissions are still pending. The user has not finished granting Accessibility and Screen Recording permissions in the ChatGPT Computer Use window.',
        'permissionsPending',
      ],
      ["Computer Use is blocked from using the app 'Mail'", 'appBlocked'],
      ["Computer Use is not allowed to use the app 'Terminal'", 'appRefused'],
      ["Computer Use approval denied via MCP elicitation for app 'Mail'", 'notApproved'],
      ["Computer Use permission request canceled for app 'Mail'", 'notApproved'],
      ['Computer Use stopped due to encountering a disallowed URL: https://www.wikiwand.com/', 'blockedUrl'],
      ['Computer Use is unavailable because the current turn ended. It will work again after the next user message.', 'turnEnded'],
      ['Computer Use is disabled by your configuration.', 'disabled'],
      ['Computer Use IPC server is unavailable.', 'serviceUnavailable'],
      ['Computer Use bootstrap failed.', 'serviceUnavailable'],
    ];
    for (const [text, kind] of cases) assert.equal(skyProblemOfItem(cuaItem(text, 'failed'))?.kind, kind, text);
  });

  test('CM-B10b: Sky stopping the session because the user stopped it reads as stopped by the user', () => {
    const text =
      "This application session has been explicitly stopped by the user for this turn. Stop your work and send a final message noting they stopped the session and you're ready to continue if they want you to. Computer Use can be used again in the next assistant turn.";
    assert.equal(skyProblemOfItem(cuaItem(text))?.kind, 'userStopped');
  });

  test("CM-B10c: Sky's client/server version mismatch reads as an update problem", () => {
    const text =
      'The Computer Use server and client have a version mismatch. To use Computer Use, ask the user to relaunch their ChatGPT app so that the client will be updated to the latest version.';
    assert.equal(skyProblemOfItem(cuaItem(text, 'failed'))?.kind, 'versionMismatch');
  });

  test("CM-B10d: Sky refusing because the Mac is locked reads as 'Your Mac is locked'", () => {
    const text =
      'The Mac is locked and this Computer Use request cannot be associated with a ChatGPT thread. Ask the user to unlock the Mac manually before continuing.';
    assert.equal(skyProblemOfItem(cuaItem(text, 'failed'))?.kind, 'screenLocked');
  });

  test('CM-B10e: Sky timing out on its connection reads as Codex Computer Use not running', () => {
    assert.equal(skyProblemOfItem(cuaItem('Timed out establishing the Computer Use connection.', 'failed'))?.kind, 'serviceUnavailable');
  });
}
