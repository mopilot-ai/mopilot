// Hides the machine's system install folders (/opt, /usr, /Applications, /System) from the fs module, so code under
// test that probes them (Codex copies, Homebrew kegs, editors) sees the same nothing on every machine: existsSync is
// true only for the paths a test lists, and every other call on a system path (stat, realpath, readFile, mkdir, ...)
// fails ENOENT in its own form (thrown, rejected or called back) without reaching the disk.
import fs from 'node:fs';
import path from 'node:path';

/** System install folders main probes: what a developer's machine has there must not reach a test. */
export const SYSTEM = /^\/(opt|usr|Applications|System)\//;
/** fs calls that take a path first, each as `name`, `nameSync` and `fs.promises.name` where Node has that form. */
export const PATH_CALLS = [
  'access',
  'appendFile',
  'chmod',
  'copyFile',
  'cp',
  'link',
  'lstat',
  'mkdir',
  'mkdtemp',
  'open',
  'opendir',
  'readFile',
  'readdir',
  'readlink',
  'realpath',
  'rename',
  'rm',
  'rmdir',
  'stat',
  'statfs',
  'symlink',
  'truncate',
  'unlink',
  'utimes',
  'writeFile',
];
/** Path-first fs calls with no other form. */
export const SYNC_ONLY = ['createReadStream', 'createWriteStream', 'watch', 'watchFile'];
/** This checkout: its own files stay readable (the module loader reads them) even where it lives under /opt or /usr. */
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
/** Set on each hidden function, so a guard can tell it from the real one. */
export const HIDDEN = Symbol('hidden system paths');

const enoent = (syscall: string, p: unknown) =>
  Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${p}'`), { code: 'ENOENT', errno: -2, syscall, path: String(p) });
/** A path given as a string, Buffer or file: URL (a file descriptor is no path), outside the checkout at `root`. */
const inSystem = (p: unknown, root: string) => {
  const s = p instanceof URL ? p.pathname : String(p);
  return SYSTEM.test(s) && !s.startsWith(`${root}/`);
};
const mark = (f: any) => Object.assign(f, { [HIDDEN]: true });
type Form = 'sync' | 'callback' | 'promise';
/** `real`, failing ENOENT for a system path the way its form fails. */
const hide = (real: any, syscall: string, form: Form, root: string) =>
  mark((p: any, ...rest: any[]) => {
    if (!inSystem(p, root)) return real(p, ...rest);
    const error = enoent(syscall, p);
    if (form === 'promise') return Promise.reject(error);
    const done = rest.at(-1);
    // a call without its callback fails where it is made, as the real one does
    if (form === 'sync' || typeof done !== 'function') throw error;
    process.nextTick(done, error);
  });

/**
 * Hide system paths from fs until the returned undo runs. `listed` are the system paths a test says exist: to
 * existsSync only, as a file the machine running the tests doesn't really have. Files under `root` (this checkout
 * by default) are never hidden.
 */
export function hideSystemPaths(listed: Set<string>, root = ROOT): () => void {
  const saved: [any, string, any][] = [];
  const swap = (obj: any, name: string, f: any) => {
    saved.push([obj, name, obj[name]]);
    obj[name] = f;
  };
  const exists = fs.existsSync;
  swap(
    fs,
    'existsSync',
    mark((p: any) => listed.has(String(p)) || (!inSystem(p, root) && exists(p))),
  );
  const forms: [any, string, string, Form][] = [
    ...PATH_CALLS.flatMap((n): [any, string, string, Form][] => [
      [fs, `${n}Sync`, n, 'sync'],
      [fs, n, n, 'callback'],
      [fs.promises, n, n, 'promise'],
    ]),
    ...SYNC_ONLY.map((n): [any, string, string, Form] => [fs, n, n, 'sync']),
  ];
  for (const [obj, name, syscall, form] of forms) {
    const real = obj[name];
    const fake = hide(real, syscall, form, root);
    // realpath.native and realpathSync.native are a second way in
    if (real.native) fake.native = hide(real.native, syscall, form, root);
    swap(obj, name, fake);
  }
  return () => {
    for (const [obj, name, f] of saved.reverse()) obj[name] = f;
  };
}
