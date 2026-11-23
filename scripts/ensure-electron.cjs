// Electron 44 has no postinstall: it downloads its binary the first time something requires `electron`.
// `npm test` runs test files in parallel, and on a fresh install several of them require it at once, so the
// downloads race on node_modules/electron/dist and one fails ("File exists"). Resolve it once, serially,
// before the parallel run.
const electronPath = require('electron');

console.log(`electron: ${electronPath}`);
