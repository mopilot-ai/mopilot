// Pure text for the motion bench's native fixture app (#3810): its Info.plist, the command that opens it in the GUI session, the script that quits it, and the read of its pid file. The compile and the launch are in bench/drivers/motionKit.mjs.

export const FIXTURE_APP_NAME = 'Motion fixture';
export const FIXTURE_APP_ID = 'ai.mopilot.motionfixture';
export const FIXTURE_APP_EXE = 'motionfixture';

/** The app bundle's Info.plist: a regular (Dock, focusable) app, not an agent app. */
export function fixtureInfoPlist() {
  const entries = [
    ['CFBundleIdentifier', 'string', FIXTURE_APP_ID],
    ['CFBundleName', 'string', FIXTURE_APP_NAME],
    ['CFBundleDisplayName', 'string', FIXTURE_APP_NAME],
    ['CFBundleExecutable', 'string', FIXTURE_APP_EXE],
    ['CFBundlePackageType', 'string', 'APPL'],
    ['CFBundleVersion', 'string', '1'],
    ['CFBundleShortVersionString', 'string', '1.0'],
    ['LSUIElement', 'false', ''],
    ['NSHighResolutionCapable', 'true', ''],
  ];
  const body = entries
    .map(([key, type, value]) => `  <key>${key}</key>\n  ${type === 'string' ? `<string>${value}</string>` : `<${type}/>`}`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
}

/** The shell command that starts a new instance of the app on `url`; the app writes its pid to `pidFile`. */
export function openFixtureAppCommand(/** @type {string} */ appPath, /** @type {string} */ url, /** @type {string} */ pidFile) {
  return `rm -f ${JSON.stringify(pidFile)}; open -na ${JSON.stringify(appPath)} --args ${JSON.stringify(url)} ${JSON.stringify(pidFile)}`;
}

/** The AppleScript line that asks the app to quit. */
export const QUIT_FIXTURE_SCRIPT = `tell application "${FIXTURE_APP_NAME}" to quit`;

/** The pid in the app's pid file, or null when the file is missing or holds anything else. */
export function parsePidFile(/** @type {string | null} */ text) {
  const pid = /^\s*(\d+)\s*$/.exec(text ?? '')?.[1];
  return pid && Number(pid) > 1 ? Number(pid) : null;
}
