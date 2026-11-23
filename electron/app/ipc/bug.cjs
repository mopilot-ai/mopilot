// IPC for bug reports (electron/support/bugReport.cjs): bug:preview builds a report for saving locally; bug:submit builds
// and sends it to MoPilot where this build has the bug intake (electron/private/service/bugIntake.cjs), and says it can't otherwise.
const path = require('node:path');
const { reportContext, buildReport } = require('../../support/bugReport.cjs');
const { optionalPrivate } = require('../../platform/optionalPrivate.cjs');

/**
 * @typedef {{ sendReport: (report: ReturnType<typeof buildReport>, o: { api: (pathname: string, init: RequestInit) => Promise<Response | null> }) => Promise<unknown> }} BugIntake
 * @type {BugIntake | null}
 */
const intake = optionalPrivate(path.join(__dirname, '../../private/service/bugIntake.cjs'));
const UNAVAILABLE = /** @type {const} */ ({
  ok: false,
  error: { kind: 'unavailable', message: 'This build sends no reports. Save the report to a file and attach it to an issue.' },
});

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {import('../../main.cjs').IpcDeps} deps main's IPC deps; the context comes from `live` (telemetry, the MoPilot account)
 * @param {typeof intake} [bugIntake] the intake to send to, for tests
 */
function register(ipcMain, deps, bugIntake = intake) {
  ipcMain.handle('bug:preview', async (_e, input) => buildReport(input, await reportContext(deps)));
  // built in main again, so what goes out is main's context and the window's scrubbed fields, never the window's copy of the rest
  ipcMain.handle('bug:submit', async (_e, input) => {
    if (!bugIntake) return UNAVAILABLE;
    const report = buildReport(input, await reportContext(deps));
    return bugIntake.sendReport(report, { api: (pathname, init) => deps.live.mopilot.api(pathname, init) });
  });
}

module.exports = { register };
