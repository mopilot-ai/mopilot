// The scratch Google Chrome profile an E2E run points the app at (its native host goes there only), and the DevTools port that Chrome writes; no Playwright, so unit tests load it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { firstPublishedLine } from '../../../scripts/fixture-json-log.mjs';

/**
 * Google Chrome as a GitHub runner (and a Mac) has it: the app bundle on macOS, the package's launcher on Linux (it runs
 * /opt/google/chrome/chrome, the browser process the app's native host check accepts), chrome.exe under Program Files on
 * Windows; CHROME_BIN points at another build.
 */
export function chromeBin(platform: string = process.platform, env: Record<string, string | undefined> = process.env) {
  if (env.CHROME_BIN) return env.CHROME_BIN;
  if (platform === 'win32')
    return path.win32.join(env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
  return platform === 'linux' ? '/usr/bin/google-chrome' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}
export const CHROME_BIN = chromeBin();

/**
 * A scratch Chrome profile folder, and the app environment that points MoPilot at it: its native host is written
 * into that folder only (MOPILOT_CHROME_NATIVE_HOST, electron/app/chromeRelay.cjs nativeHostIds), and a page MoPilot opens in "the user's Chrome" goes to this Chrome. The folder must exist before the app starts (hostFolders).
 */
export function scratchChromeProfile() {
  const dir = path.join(os.tmpdir(), `mopilot-e2e-chrome-${randomUUID().slice(0, 8)}`);
  return {
    dir,
    env: {
      MOPILOT_CHROME_NATIVE_HOST: '1',
      MOPILOT_CHROME_RELAY_USER_DATA_DIR: dir,
      MOPILOT_CHROME_RELAY_EXECUTABLE: CHROME_BIN,
    },
    create: () => fs.mkdirSync(dir, { recursive: true }),
    remove: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }),
  };
}

/** The port Chrome wrote to DevToolsActivePort (its first line) once it listens; null until then. */
export function devToolsPort(text: string | null): number | null {
  const port = Number(firstPublishedLine(text));
  return Number.isSafeInteger(port) && port > 0 && port <= 65535 ? port : null;
}
