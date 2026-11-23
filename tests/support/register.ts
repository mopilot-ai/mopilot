// Loaded with --import for every unit test: resolve the app's extensionless imports and its CSS Modules, and compile
// .tsx with an inline source map so coverage is reported against the source lines.
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';
// a test that starts a real app (a browser, the computer-use helper, macOS open) fails instead of opening it here
import './no-real-apps.ts';
import { installBriefAssert } from './brief-assert.ts';
import { startRssWatchdog } from './rss-watchdog.ts';
import { startExitWatchdog } from './exit-watchdog.ts';
import { isolateTmpdir } from './test-tmpdir.ts';
import { checkKeptJson } from './kept-json-check.ts';

// a failing assertion on a DOM node or event reports it in one line instead of walking the whole window
installBriefAssert();
// and a test process that runs away with memory anyway is killed with the reason instead of taking the computer down
startRssWatchdog();
// and a test file that finished but stays alive (a leaked timer or socket) fails with what is open instead of stalling the run
startExitWatchdog();
// and every temp folder a test makes lands in this process's own folder, removed when it exits, so fixtures that never
// clean up cannot fill the OS temp folder (860k leaked folders slowed the whole Mac)
isolateTmpdir();
// and a stream event that changes after main kept its JSON for the windows fails the test that changed it
checkKeptJson();
// and every test runs on the checkout's own Rust core, as the app does: the run built it (scripts/test-global-setup.mjs), the
// domains it owns have no JS copy to fall back on, and a test of how a caller handles the core injects its fake
const CORE_BUILDS: Record<string, string> = { darwin: 'libmopilot_core.dylib', linux: 'libmopilot_core.so', win32: 'mopilot_core.dll' };
process.env.MOPILOT_CORE ??= fileURLToPath(new URL(`../../core/target/release/${CORE_BUILDS[process.platform]}`, import.meta.url));

/**
 * What the core answers here without acting: tests that pretend to be on Windows use made-up pids, and proc.kill would
 * end whatever real process has that pid. The binding's own tests (tests/coreBinding*.test.ts) start the real children
 * they end, so they call the routes themselves.
 */
const BINDING_TEST = /[\\/]coreBinding[^\\/]*\.test\.ts$/;
const INERT_ROUTES: Record<string, string> = { 'proc.kill': '[]', 'proc.contain': 'false', 'proc.endContained': '[]' };
const dlopen = process.dlopen;
process.dlopen = function loadInert(module: { exports: any }, ...rest: any[]) {
  (dlopen as any).call(process, module, ...rest);
  const addon = module.exports;
  if (typeof addon.dispatch !== 'function' || BINDING_TEST.test(process.argv[1] ?? '')) return;
  const { dispatch, dispatchSync } = addon;
  const inert = (route: string) => (Object.hasOwn(INERT_ROUTES, route) ? Buffer.from(INERT_ROUTES[route]) : null);
  addon.dispatch = (route: string, payload: Buffer) => {
    const reply = inert(route);
    return reply ? Promise.resolve(reply) : dispatch(route, payload);
  };
  if (dispatchSync) addon.dispatchSync = (route: string, payload: Buffer) => inert(route) ?? dispatchSync(route, payload);
} as typeof process.dlopen;

const EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

/**
 * A CSS Module (`styles from './x.module.css'`) as an identity map: `styles.prRow` is `'prRow'`, the class as written
 * in the stylesheet, where Vite would hash it. A data: URL, so the kits' hooks that load a plain stylesheet as an
 * empty module (which has no default export) never see it.
 */
export const CSS_MODULE = `data:text/javascript,${encodeURIComponent(
  "export default new Proxy({}, { get: (_, key) => (typeof key === 'string' ? key : undefined) });",
)}`;

/** The repository's own tsconfig: what a file whose nearest tsconfig cannot be loaded compiles with. */
const ROOT_TSCONFIG = fileURLToPath(new URL('../../tsconfig.json', import.meta.url));

export function compileTsx(source: string, filename: string, tsconfig: string | boolean = true) {
  const out = transformSync(filename, source, { jsx: { runtime: 'automatic' }, sourcemap: true, tsconfig });
  // a subproject's tsconfig that extends a package only its own install has (the mobile app's extends Expo's): the unit
  // run installs the root's packages only, so such a file compiles with the repository's tsconfig instead (#2845)
  if (tsconfig === true && out.errors.some((e) => e.message.includes('TSCONFIG_ERROR'))) return compileTsx(source, filename, ROOT_TSCONFIG);
  if (out.errors.length) throw new Error(`${filename}: ${out.errors.map((e) => e.message).join('\n')}`);
  const map = Buffer.from(JSON.stringify(out.map)).toString('base64');
  return `${out.code}\n//# sourceMappingURL=data:application/json;base64,${map}\n`;
}

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('.module.css')) return { url: CSS_MODULE, shortCircuit: true };
    try {
      return next(specifier, context);
    } catch (e) {
      if (!/^\./.test(specifier) || /\.[cm]?[jt]sx?$/.test(specifier)) throw e;
      for (const ext of EXTENSIONS) {
        try {
          return next(specifier + ext, context);
        } catch {
          /* try the next extension */
        }
      }
      throw e;
    }
  },
  load(url, context, next) {
    // mock.module loads its stand-in at `<url>?node-test-mock=N`
    const bare = url.split(/[?#]/)[0];
    if (!url.startsWith('file:') || !bare.endsWith('.tsx')) return next(url, context);
    const file = fileURLToPath(bare);
    return { format: 'module', shortCircuit: true, source: compileTsx(readFileSync(file, 'utf8'), file) };
  },
});
