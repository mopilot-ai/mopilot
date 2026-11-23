// Which unit tests exercise a set of source files: every top-level test that reaches one of them through
// imports, requires, or a repository path it names (tests that load a component from its path); a module a test only
// stubs is not reached (scripts/source-references.mjs). Lets an agent go from "what did I change" to "what do I run"
// without grepping.
//
//   npm run test:related -- src/lib/format.ts electron/main.cjs   (print the tests)
//   npm run test:related -- --changed[=<base>]                     (for everything changed vs origin/main)
//   npm run test:related -- --direct …                             (only tests that name the files themselves)
//   npm run test:coverage -- --changed --related                   (run them and enforce changed-line coverage)
// It also names the E2E specs that reach the files (through tests/e2e/fixtures, which get an app rule a spec depends
// on from its module rather than restating it). They are release-only (AGENTS.md), so they are listed, not run: a
// change that alters what they check updates them in the same pull request.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLintFile, lintKeys } from './lint-references.mjs';
import { inHiddenFolder } from './source-tree.mjs';
import { GUARDS_DECLARATION, referencesOf, SOURCE, TEST_DIRS, walk } from './source-references.mjs';

export { referencesOf, resolveSpecifier, withoutStubs } from './source-references.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// the app's sources, then the web app's (the same folders c8 measures; web/tests covers them)
const SOURCE_DIRS = [
  'src',
  'electron',
  'shared',
  'relay',
  'host',
  'scripts',
  'bench/lib',
  'web/app',
  'web/components',
  'web/db',
  'web/lib',
  'mobile',
];
const SOURCE_FILES = ['web/proxy.ts', 'bench/bench-chrome.mjs', 'bench/drivers/mgb.mjs', 'bench/mgb-run.mjs'];
// shared test harnesses: they load sources for the tests that use them, so they pass on what they load (not what they stub)
const HELPER_DIRS = ['tests/support', 'tests/helpers', 'web/tests/support', 'tests/e2e/fixtures', 'tests/fixtures'];
const E2E_DIR = 'tests/e2e';
const E2E_SPEC = /^tests\/e2e\/[^/]+\.spec\.ts$/;
/** Every path the graph reads (the helper folders sit inside the test folders). */
export const GRAPH_PATHS = [...SOURCE_DIRS, ...SOURCE_FILES, ...TEST_DIRS];
const TOP_TEST = /^(?:web\/)?tests\/[^/]+\.test\.ts$/;

/** Map each file to the files that reference it (sources and top-level tests). */
export function reverseGraph(repoRoot = root, read = (f) => readFileSync(path.join(repoRoot, f), 'utf8')) {
  const tests = [...TEST_DIRS, E2E_DIR]
    .filter((d) => existsSync(path.join(repoRoot, d)))
    .flatMap((d) =>
      readdirSync(path.join(repoRoot, d))
        .filter((f) => f.endsWith(d === E2E_DIR ? '.spec.ts' : '.test.ts'))
        .map((f) => `${d}/${f}`),
    );
  const sources = [
    ...[...SOURCE_DIRS, ...HELPER_DIRS].flatMap((d) => walk(path.join(repoRoot, d))).map((p) => path.relative(repoRoot, p)),
    ...SOURCE_FILES.filter((f) => existsSync(path.join(repoRoot, f))),
  ];
  const users = new Map();
  for (const file of [...sources, ...tests]) {
    for (const target of referencesOf(file, read(file), repoRoot)) {
      if (!users.has(target)) users.set(target, new Set());
      users.get(target).add(file);
    }
  }
  return users;
}

/**
 * Every top-level test that reaches one of `files`, sorted. Transitive by default (a test of a component also
 * exercises the helpers it imports, unless it stubs them); `direct` keeps only tests that reference the files.
 */
export function relatedTests(files, users, { direct = false } = {}) {
  return reaching(files, users, TOP_TEST, direct);
}

/** Every E2E spec that reaches one of `files` (or is one), sorted: what a change should update, not run. */
export function relatedSpecs(files, users) {
  return reaching(files, users, E2E_SPEC, false);
}

/**
 * A package.json inside a source folder (shared/package.json): its "type" decides how Node loads every module under
 * it, so a change there reaches all of them without any import edge leading to it (#2067 made shared/ ES and broke a
 * test of a types-only shared module that no changed file reached).
 */
export const isModuleTypeFile = (/** @type {string} */ f) => f.endsWith('/package.json') && SOURCE_DIRS.some((d) => f.startsWith(`${d}/`));

/**
 * A GitHub workflow: no import reaches it, but a test that names its path reads it, so a change to one must run that
 * test (#3805 added a release job, and tests/releaseView, which names every job, first failed on main: #3828).
 */
export const isWorkflowFile = (/** @type {string} */ f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f);

/** Whether a changed path selects unit tests: a graph file, a source folder's package.json, or a workflow. */
export const selectsTests = (/** @type {string} */ f) => isGraphFile(f) || isModuleTypeFile(f) || isWorkflowFile(f);

/** The files a changed path seeds the search with: a source folder's package.json stands for every module under it. */
function seedsOf(/** @type {string} */ file, /** @type {Map<string, Set<string>>} */ users) {
  if (!isModuleTypeFile(file)) return lintKeys(file);
  const dir = file.slice(0, -'package.json'.length);
  return [...users.keys()].filter((f) => f.startsWith(dir));
}

/** The files matching `top` that reach `files` through `users`. */
function reaching(files, users, top, direct) {
  const seeds = files.flatMap((f) => seedsOf(f, users));
  const seen = new Set(seeds);
  const queue = [...seeds];
  const found = new Set(files.filter((f) => top.test(f)));
  while (queue.length) {
    for (const user of users.get(queue.shift()) ?? []) {
      if (seen.has(user)) continue;
      seen.add(user);
      if (top.test(user)) found.add(user);
      // a top-level test or spec is an end; a shared harness is transparent: a test that loads a file through it
      // reaches that file directly
      else if (!TOP_TEST.test(user) && !E2E_SPEC.test(user) && (!direct || HELPER_DIRS.some((d) => user.startsWith(`${d}/`))))
        queue.push(user);
    }
  }
  return [...found].sort();
}

/** The note that names the E2E specs reaching a change, or '' for none. */
export const specsNote = (/** @type {string[]} */ specs) =>
  specs.length
    ? `E2E specs that reach this change (release-only, not run here; update them in this change if it alters what they check):\n${specs.map((s) => `  ${s}`).join('\n')}`
    : '';

/**
 * Legacy: this list no longer grows. Name a new whole-repository invariant `tests/<name>.invariant.test.ts` instead
 * (`INVARIANT_TEST_NAMES` below finds it); the merge gate ignores edits confined to this block (`listOnlyChange`).
 *
 * Tests that check the repository as a whole: harness-name ceilings, the Settings row budget, stylesheet structure,
 * user-visible strings, docs that name tests or are generated, the PR check running what the pre-commit hook runs,
 * and the control matrix that every harness change can break. A change breaks them without any import leading there
 * (one more Settings row, an unclosed CSS rule, a renamed test title, a new hook step), so every `--related` run
 * includes them for app changes; unrelated web, documentation and tooling changes keep the global safeguards.
 */
const LISTED_INVARIANT_TESTS = [
  'tests/acceptance.test.ts',
  // no test sets TZ in its module body, after its helpers made their dates on the runner's zone
  'tests/testTimezoneSetup.test.ts',
  // every test runner leases from the machine's shared worker budget, and every test process gets its own temp folder
  'tests/testSlotsInvariant.test.ts',
  'tests/testTmpdir.test.ts',
  // a lock or cache several processes share is not under os.tmpdir(), which each test process has its own of (#2374)
  'tests/crossProcessLockInvariant.test.ts',
  // every gate on the user's word reads isUserTurn (#2249)
  'tests/userTurnAuthority.test.ts',
  // every native debugger attach/detach in the Chrome extension goes through debuggers.mjs's foreign-frame handling
  'tests/chromeDebuggerCallSites.test.ts',
  'tests/shortcutCatalog.test.ts',
  'tests/boundary.test.ts',
  // behavioral prevention guards: permission owner lifetimes, structured identity and boundary validation
  'tests/desktopCardsUI.test.ts',
  'tests/preventionContracts.test.ts',
  // every attachment kind must remain intact when its selected transport cannot represent it
  'tests/composerCloudInput.test.ts',
  'tests/cjk-ui-strings.test.ts',
  // a global class's base rule is in one stylesheet, or listed as one component styled in layers
  'tests/cssClassOwners.test.ts',
  // the rows stacked around a chat's transcript wrap their actions under their text, so none can squeeze it to nothing (#2119, #2120)
  'tests/noticeRowWrap.test.ts',
  // an icon beside wrapping text is one text line tall, so it stays centred on that line at any Chat font size
  'tests/iconLineCentre.test.ts',
  // only the chat on screen opens its side pane: every pane opener is listed with why it may
  'tests/paneOpenInvariants.test.ts',
  // MoMo's chats are in no list: every source that enumerates chats skips them or is listed with why (#2139)
  'tests/momoChatLists.test.ts',
  'tests/momoToolScope.test.ts',
  // every helper run written for a MoMo chat (a handoff note, a title) is confined like the chat, on every harness (#2364)
  'tests/momoHelperConfinement.test.ts',
  // every harness MoMo runs on keeps its own tools and instructions out: each family and ACP quirk says how, or is refused (#2278)
  'tests/momoHarnessConfinement.test.ts',
  // every tool MoPilot registers reads as a step line, in every harness's form of its name, never as its raw name (#2280)
  'tests/ownToolLines.test.ts',
  // MoMo's Codex threads run on an app-server of their own home, with no user AGENTS.md, skills, hooks or memories (#2308)
  'tests/momoCodexConfinement.test.ts',
  // no thread of a MoMo chat has Codex's own shell: its requests are isolated, MoMo's home switches the tools off (#2139)
  'tests/momoCodexShellOff.test.ts',
  // every MoMo service method is called by the app, or listed as internal or deferred with its issue (#2285)
  'tests/momoEntryPoints.test.ts',
  // runs tsc over controller.cjs's whole type graph in a child process, which the import scan can't follow: a type
  // import anywhere in that graph (src/store/types.ts reaching the store, #2124) breaks it unseen (#2115)
  'tests/sendReceiptTypes.test.ts',
  // one name for the built-in browser in every user- and model-visible string (#1523)
  'tests/browserName.test.ts',
  // every Settings row with a fixed name is found by Settings search (#1869)
  'tests/settingsSearchCoverage.test.ts',
  // one "Done, continue" label for the button and every model-facing string that names it (#1834)
  'tests/doneContinueLabel.test.ts',
  // every Settings → X names a sidebar page and every quoted button label is one the app draws (#1860)
  'tests/uiLabelReferences.test.ts',
  // shared UI names a harness only where it is the subject, each place listed with why
  'tests/harnessNamedCopy.test.ts',
  // every module under electron/momo that keeps data belongs to a store Reset MoMo deletes, registered once wired (#2139)
  'tests/momoStoresInvariant.test.ts',
  // a MoMo chat's Claude Code session is allowlist-only: no built-in tool, no other MCP server, connector or skill (#2305)
  'tests/momoClaudeConfinement.test.ts',
  // after Reset MoMo, a write to every registered MoMo store succeeds without a restart (#2291, #2307)
  'tests/momoResetRecovery.test.ts',
  // an agent tool's harness, model or effort choice stands only when the user named it (session/userWords.cjs, #2084)
  'tests/agentChoiceOwner.test.ts',
  // every Codex Stop goes through request(), which ends the stopped turn's commands (#1940)
  'tests/codexStopChokePoint.test.ts',
  // card, notice and settings copy fits one line, as short as Claude Desktop's and the Codex app's
  'tests/copyLength.test.ts',
  // every pref is read outside its declaration, default and Settings, or listed with why (#1861)
  'tests/prefsRead.test.ts',
  // Enter and Escape handlers leave an input method's keys alone (src/lib/focus.ts imeComposing)
  'tests/imeKeys.test.ts',
  // one virtual-machine check (electron/platform/virtualMachine.cjs), so the VM-only bench switch can't drift from the suites' gate (#1600)
  'tests/virtualMachine.test.ts',
  // every bench instance starts Claude with Claude in Chrome off unless the run paired one inside the VM (#1561)
  'tests/benchClaudeChrome.test.ts',
  'tests/harnessMatrix.test.ts',
  // every Changes surface counts a turn through changedFiles: applied, in the chat's folder, not undone (#1939)
  'tests/changedFilesReaders.test.ts',
  // every harness family's stream deltas pass the batcher in main (core/crates/batcher)
  'tests/streamContracts.test.ts',
  // the per-feature IPC registries (electron/bridge, src/lib/native, electron/app/ipc), loaded by listing their folders
  'tests/ipcRegistry.test.ts',
  // unit tests never start a real app (tests/support/no-real-apps.ts)
  'tests/noRealApps.test.ts',
  // the current chat is the focused pane's (src/store/split.ts), and an untargeted composer event reaches one composer
  'tests/splitViewInvariants.test.ts',
  // rule fixtures own the entire Biome project scan, not a disappearing folder inside the checkout
  'tests/biomeFixtureOwnership.test.ts',
  // every stapler command runs under scripts/notary.mjs's retry, and nothing notarizes through @electron/notarize (0.3.42)
  'tests/notaryInvariant.test.ts',
  // checkout-only orchestration imports and actual graph traversal cannot depend on installed packages
  'tests/ciDependencies.test.ts',
  // shell commands and extracted spec callbacks retain the focused tests that model their real boundaries
  'tests/relatedTestsFixtures.test.ts',
  // every main checkpoint keeps both suites on one SHA, bounded jobs/retries and one trigger owner
  'tests/mainValidationWorkflow.test.ts',
  // a release skips only the suites main's runs passed, read off the jobs main-validation.yml calls them as
  'tests/releaseSuitesMatch.test.ts',
  // main in a unit test never reads the machine's /opt, /usr or /Applications: every fs call it makes is hidden there
  'tests/hermeticSystemFs.test.ts',
  // E2E app-chrome locators must not use navigation retired by a sidebar redesign
  'tests/e2eNavigationContract.test.ts',
  // a class written beside .text-input/.text-area anywhere in src is not overridden by the shared rule (controls.css)
  'tests/textInputCascade.test.ts',
  // every unit-test entry point reports DOM values in brief and kills a runaway process (tests/support/rss-watchdog.ts)
  'tests/rssWatchdog.test.ts',
  // a test file that passes but stays alive on a leaked handle fails fast instead of stalling the run (#1759)
  'tests/exitWatchdog.test.ts',
  // every .ts a Node script imports is an ES module by its package.json, so hooks' stderr carries no Node warning
  'tests/scriptTsModuleType.test.ts',
  // only electron/harness/claude/rename.cjs names a Claude Code session, so every name also lands where the SDK reads it past 128 KB (#1932)
  'tests/claudeRenameOwner.test.ts',
  // every source file has a header comment, and the generated module map stays uncommitted
  'tests/moduleMap.test.ts',
  // structural merge rules and bug-class guide shape have no source import edge
  'tests/mergeAttributes.test.ts',
  'tests/persistedContextNotes.test.ts',
  'tests/prUnitTestsWorkflow.test.ts',
  'tests/commitStatusWorkflow.test.ts',
  'tests/commitStatusCurl.test.ts',
  // only the shared writer sets the renderer's Claude account list, so a new login in use is detected (src/session/harness/claude/accounts.ts)
  'tests/claudeStartupDetect.test.ts',
  // a chat's Claude in Chrome link is kept to its current segment (electron/session/segmentScope.cjs)
  'tests/segmentScope.test.ts',
  // a Claude Code config's account is named for a login only through electron/harness/claude/loginIdentity.cjs
  'tests/claudeLoginNames.test.ts',
  // two logins are one account only by server identity (electron/identity/contract/sameAccount.cjs), never by their emails
  'tests/sameAccountGuard.test.ts',
  // the default harness for new chats is one pref read through one resolver (src/harness/defaultHarness.ts)
  'tests/defaultHarnessReaders.test.ts',
  'tests/settingsSnapshot.test.ts',
  // the account surfaces read status, name, plan and usage only from the account view (issue #1292)
  'tests/accountSurfaceGuard.test.ts',
  'tests/styles.test.ts',
  // navigation and titles keep separate intrinsic tracks across sidebar, platform and fullscreen states
  'tests/titleBarUI.test.ts',
  'tests/thirdParty.test.ts',
  // every package electron/ and shared/ load is a production dependency the packaged app keeps (scripts/runtime-deps.mjs)
  'tests/packagedDependencies.test.ts',
  // every admin page checks the role itself; a new page imports nothing that leads here
  'web/tests/adminGuard.test.ts',
];

/**
 * The repository's top-level tests matching `pattern`, sorted: a path whose file name may hold `*` (any characters but
 * `/`), as in `tests/controlMatrix*.test.ts`; a path without one names itself. Lists that pick up a family of tests by
 * name (the control matrix, a suite in tests/suites.json) read the folder instead of naming each file, so pull requests
 * that each add one never edit the same list.
 */
export function discoverTests(/** @type {string} */ pattern, repoRoot = root) {
  if (!pattern.includes('*')) return [pattern];
  const dir = path.posix.dirname(pattern);
  const matches = patternTest(pattern);
  if (!existsSync(path.join(repoRoot, dir))) return [];
  return readdirSync(path.join(repoRoot, dir))
    .map((file) => `${dir}/${file}`)
    .filter((file) => matches.test(file))
    .sort();
}

/** A test-file pattern (`*` in its file name) as a regular expression over repository paths. */
const patternTest = (/** @type {string} */ pattern) =>
  new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*')}$`,
  );

/** The control matrix's tests (docs/control-plane/matrix.md): IAB, CU and BU on every harness and across switches. */
export const CONTROL_MATRIX_TESTS = 'tests/controlMatrix*.test.ts';
const CONTROL_MATRIX_TEST = patternTest(CONTROL_MATRIX_TESTS);

/**
 * A whole-repository invariant test is named `tests/<name>.invariant.test.ts` and found by that name, so a pull request
 * that adds one edits no list: a registry several pull requests append to conflicts between them, and its change
 * stales every other pull request's finished check (docs/bug-prevention/change-contract.md, shared writes).
 */
export const INVARIANT_TEST_NAMES = 'tests/*.invariant.test.ts';
const INVARIANT_TEST_NAME = patternTest(INVARIANT_TEST_NAMES);

/**
 * The listed invariant tests, every control-matrix test and every `*.invariant.test.ts`, found by name when this module
 * loads: a new `tests/controlMatrix<Stream>.test.ts` or `tests/<name>.invariant.test.ts` is one without an entry here.
 */
export const INVARIANT_TESTS = [
  ...new Set([...LISTED_INVARIANT_TESTS, ...discoverTests(CONTROL_MATRIX_TESTS), ...discoverTests(INVARIANT_TEST_NAMES)]),
];

/** Whether `file` is a whole-repository invariant test, in this checkout or another tree (the merge gate's). */
export const isInvariantTest = (/** @type {string} */ file) =>
  LISTED_INVARIANT_TESTS.includes(file) || CONTROL_MATRIX_TEST.test(file) || INVARIANT_TEST_NAME.test(file);

/** The listed invariant tests alone: a legacy list that no longer grows (a new invariant is found by name instead). */
export const LEGACY_INVARIANT_TESTS = LISTED_INVARIANT_TESTS;

const APP_BEHAVIOR_TESTS = new Set([
  'tests/segmentScope.test.ts',
  'tests/desktopCardsUI.test.ts',
  'tests/preventionContracts.test.ts',
  'tests/composerCloudInput.test.ts',
]);

/** The lint ratchet's configuration: biome.json, the GritQL rules and the baseline that records each rule. */
const LINT_CONFIG = /^(?:biome\.json|lint\/rules\/[^/]+\.grit|lint\/baseline\.json)$/;

/**
 * The paths an invariant test guards, from its `export const GUARDS = [<folder>/, <file>, …]`: a folder (ending in `/`) or
 * a file whose change can break it without an import edge the graph follows. `['*']`, every path, when it declares
 * none: the app-or-not rule in `invariantTestsFor` then decides (docs/architecture/modularization.md §5).
 */
export function guardsOf(/** @type {string} */ text) {
  const list = GUARDS_DECLARATION.exec(text)?.[1] ?? '';
  const guards = [...list.matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
  return guards.length ? guards : ['*'];
}

/** A test's text in this checkout. */
const readHere = (/** @type {string} */ f) => readFileSync(path.join(root, f), 'utf8');
/** Each reader's parsed GUARDS by test: `invariantTestsFor` runs per change, over the same ~200 files. */
const guardsCache = new WeakMap();

/** Whether a changed path is under one of `guards`. */
const guarded = (/** @type {string[]} */ guards, /** @type {string} */ file) =>
  guards.some((g) => g === '*' || file === g || file.startsWith(g.endsWith('/') ? g : `${g}/`));

/** The areas a change may stay inside for `GUARDS` to scope it; a change anywhere else keeps the whole bundle. */
const KNOWN_AREA =
  /^(?:src|electron|shared|native|tests|web|bench|docs|scripts|mobile|relay|host|design|designs|deploy|conformance)\/|^README\.md$/;
/**
 * The areas without app code, which skip the cross-harness bundle: design/ and designs/ hold design pages and phone
 * spikes, deploy/ the relay's server configuration, conformance/ the nightly conformance results. mobile/, relay/ and
 * host/ share code and protocols with the app, so they keep it.
 */
const NOT_APP = /^(?:web\/|bench\/|docs\/(?!control-plane\/)|scripts\/|design\/|designs\/|deploy\/|conformance\/|README\.md$)/;
/** The selectors: a change to one decides which tests every change runs, so it keeps the whole bundle. */
const SELECTOR = /^scripts\/(?:related-tests|source-references|lint-references|focused-unit-coverage)\.mjs$/;

/**
 * Mandatory repository safeguards for the changed paths. A test that declares `GUARDS` runs when a change touches one
 * of them; the others keep the app-or-not rule below. Root configuration, an unknown path or a selector edit keeps
 * every one. `read` gives a test's text (a missing one guards every path).
 */
export function invariantTestsFor(files, read = readHere) {
  if (!files.length) return [];
  // Keep the full cross-harness bundle for app code and its fixtures, harnesses and design evidence.
  // Only known unrelated areas skip it; selector edits and unknown paths (including root configuration) keep it.
  const app = files.some((file) => !NOT_APP.test(file) || SELECTOR.test(file));
  const whole = files.some((file) => !KNOWN_AREA.test(file) || SELECTOR.test(file));
  if (!guardsCache.has(read)) guardsCache.set(read, new Map());
  const cache = guardsCache.get(read);
  const declared = (/** @type {string} */ test) => {
    if (!cache.has(test)) {
      try {
        cache.set(test, guardsOf(read(test)));
      } catch {
        cache.set(test, ['*']);
      }
    }
    return cache.get(test);
  };
  const tests = INVARIANT_TESTS.filter((test) => {
    if (whole) return true;
    const guards = declared(test);
    if (!guards.includes('*')) return files.some((file) => guarded(guards, file));
    return app || (!CONTROL_MATRIX_TEST.test(test) && !APP_BEHAVIOR_TESTS.has(test));
  });
  // Root tests run before web's npm ci; JSON dependency edits have no source-graph edge to this real-loader guard.
  const loaders = files.some((file) => file === 'package.json' || file === 'package-lock.json') ? ['tests/testLoaders.test.ts'] : [];
  // A lint rule or its baseline entry has no source-graph edge to the test that every rule is recorded (#1604).
  const lint = files.some((file) => LINT_CONFIG.test(file)) ? ['tests/lintRatchet.test.ts'] : [];
  return [...tests, ...loaders, ...lint];
}

/**
 * Every file changed against `base`, untracked ones included. Deleted ones only with `deleted`, which also lists a
 * rename as the deletion of its old path: what the invariants and lint configuration check, not what coverage measures.
 */
export function changedPaths(base, git, { deleted = false } = {}) {
  // the same comparison as the changed-coverage check (scripts/diff-coverage.mjs): the merge base, so a
  // branch behind its target does not pick up the target's own changes
  const mergeBase = git(['merge-base', base, 'HEAD']).trim();
  const tracked = git(['diff', '--no-ext-diff', '--name-only', deleted ? '--no-renames' : '--diff-filter=d', mergeBase]).split('\n');
  const untracked = git(['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .filter((f) => !inHiddenFolder(f));
  return [...new Set([...tracked, ...untracked])].filter(Boolean);
}

/** Whether a repository path is a source or test file the graph follows. */
export const isGraphFile = (/** @type {string} */ f) =>
  SOURCE.test(f) && (SOURCE_FILES.includes(f) || [...TEST_DIRS, ...SOURCE_DIRS].some((d) => f.startsWith(`${d}/`)));

/**
 * Source and test files changed against `base`, untracked ones included, a source folder's package.json changed or
 * deleted, a workflow changed or deleted, and lint configuration changed or deleted: a deleted rule still reaches the
 * tests that name it, while a deleted source has no lines left to measure.
 */
export function changedFiles(base, git) {
  const withDeleted = changedPaths(base, git, { deleted: true });
  return [
    ...new Set([
      ...changedPaths(base, git).filter(isGraphFile),
      // a deleted package.json changes how its folder loads as much as an added or edited one
      ...withDeleted.filter(isModuleTypeFile),
      ...withDeleted.filter(isWorkflowFile),
      ...withDeleted.filter(isLintFile),
    ]),
  ];
}

export function main(
  args,
  {
    git = (a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }),
    log = console.log,
    warn = console.error,
    repoRoot = root,
  } = {},
) {
  /** @type {string | null} */
  let base = null;
  let direct = false;
  const named = [];
  for (const arg of args) {
    if (arg === '--') continue;
    if (arg === '--direct') direct = true;
    else if (arg === '--changed') base = 'origin/main';
    else if (arg.startsWith('--changed=')) base = arg.slice(10);
    else named.push(path.relative(repoRoot, path.resolve(repoRoot, arg)));
  }
  const files = [...named, ...(base ? changedFiles(base, git) : [])];
  if (!files.length) throw new Error('Name source files or pass --changed[=<base>]: npm run test:related -- src/lib/format.ts');
  const users = reverseGraph(repoRoot);
  const tests = relatedTests(files, users, { direct });
  for (const test of tests) log(test);
  const note = specsNote(relatedSpecs(files, users));
  if (note) warn(note);
  return tests;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!main(process.argv.slice(2)).length) console.error('No unit test reaches these files.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
