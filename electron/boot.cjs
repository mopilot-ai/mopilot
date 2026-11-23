// Electron's entry point: installs the release smoke launch's reporter (electron/app/smokeLaunch.cjs), then loads main, or without the Rust core the stop that says why.
// boot to mainLoaded is the time main's modules take to load (electron/perf/startup.cjs). No compile cache: V8 bytecode
// read from a folder the user can write would bypass the asar integrity the release fuses enforce (rust-core.md §2).
const { markStartup } = require('./perf/startup.cjs');
markStartup('boot');
// each file's own load time, for the probe (electron/perf/requireTimes.cjs); measuring only, so an env var may ask for it
if (process.env.MOPILOT_REQUIRE_TIMES === '1') require('./perf/requireTimes.cjs').timeRequires();
require('./app/smokeLaunch.cjs').installSmokeLaunch({ app: require('electron').app });
// main's services hold the Rust core from the moment they are built: without it, the app says why and exits instead
const coreMissing = require('./platform/core.cjs').coreProblem();
if (coreMissing) void require('./app/withoutCore.cjs').stopWithoutCore(coreMissing);
else {
  require('./main.cjs');
  markStartup('mainLoaded');
}
