// The files every test or every spec depends on without importing them, which no import graph can follow: the merge
// gate retests a pull request when one changes (scripts/merge-gate.mjs), a main-e2e cycle runs the whole suite
// (scripts/main-e2e-scope.mjs), and while main is red one reaches its failing tests (scripts/red-hold.mjs).
import { isExceptionsFile } from './file-size.mjs';
import { isGraphFile } from './related-tests.mjs';

// files every unit test or every file's lint depends on without importing them: dependencies, compiler settings, the
// loaders every test gets through --import, the test runner, the check's own scripts and the lint rules. A test helper
// is imported, so the graph follows it to the tests that use it; lint/baseline.json is judged per file (baselineReach).
const SHARED =
  /^(?:web\/)?(?:package(?:-lock)?\.json|tsconfig[^/]*\.json)$|^\.c8rc\.json$|^biome\.json$|^tests\/support\/register\.ts$|^(?:web\/)?tests\/(?:setup\.ts|suites\.json)$|^scripts\/(?:unit-coverage|diff-coverage|related-tests|source-references|lint-references|lint-ratchet)\.mjs$|^lint\/(?!baseline\.json$)/;
// a helper file no import reaches (a fixture a helper reads) is not in the graph, so any test may depend on it
const HELPER = /^(?:web\/)?tests\/(?:support|helpers)\//;
// the file-size exceptions are the exception: no unit test reads them (scripts/gate-exemptions.mjs)
export const isShared = (/** @type {string} */ file) =>
  !isExceptionsFile(file) && (SHARED.test(file) || (HELPER.test(file) && !isGraphFile(file)));

// What the merge gate calls shared changes what every spec runs on, so it runs them all, except the files only the
// unit tests and the linter read.
const UNIT_ONLY =
  /^(?:web\/|biome\.json$|lint\/|\.c8rc\.json$|scripts\/(?:unit-coverage|diff-coverage|related-tests|source-references|lint-references|lint-ratchet)\.mjs$|tests\/(?:support\/register\.ts|setup\.ts|suites\.json)$)/;
// and what the specs run on without importing it: the app's shell and native helpers, how the renderer and sage-mcp are
// built and Electron fetched, the Playwright setup, and main's E2E workflow
const E2E_GLOBAL =
  /^(?:native\/|vite\.config\.[cm]?[jt]s$|index\.html$|scripts\/(?:build-[\w-]+|publish-native|ensure-electron|release-suites|e2e-own-runner)\.|tests\/e2e\/(?:playwright\.config|performance\.config|global-setup|workers)\.|\.github\/release-repo\/main-e2e\.yml$)/;
/** Whether a change to `file` can alter any spec's result without a spec importing it. */
export const needsFullRun = (/** @type {string} */ file) => (isShared(file) && !UNIT_ONLY.test(file)) || E2E_GLOBAL.test(file);
