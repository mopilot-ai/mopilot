// The one shared fake of the renderer's native port (docs/architecture/modularization.md §3): every namespace and call the
// bridge declares (electron/bridge/*.cjs), so a test names only the calls it cares about. An invoke or call resolves
// undefined, a send returns nothing, an `on` subscription returns its unsubscribe and can be fired with `emit`, and every
// call is recorded. An override names only what the bridge declares (a typo fails here, as a stub of a missing export
// did), and `null` for a namespace leaves it out, as a preload without it would. Install it with
// `useFakeNative(t, overrides)` instead of stubbing src/lib/native.ts or window.native.
import { createRequire } from 'node:module';
import { installNative, type NativeApi } from '../../../src/lib/native.ts';

const require = createRequire(import.meta.url);
const { loadBridge, RESERVED } = require('../../../electron/bridge/spec.cjs');

type Overrides = { [key: string]: unknown };
export type FakeNative = NativeApi & {
  /** every call made, in order, by its dotted path (`chats.list`) */
  calls: { path: string; args: unknown[] }[];
  /** the arguments of each call to `path`, in order */
  callsTo(path: string): unknown[][];
  /** fire an `on` subscription's callbacks */
  emit(path: string, ...args: unknown[]): void;
};

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A fake of the whole bridge, with `overrides` (functions or values, nested by namespace) in place of the defaults. */
export function fakeNative(overrides: Overrides = {}): FakeNative {
  const calls: { path: string; args: unknown[] }[] = [];
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const recorded =
    (path: string, fn: (...args: any[]) => unknown) =>
    (...args: unknown[]) => {
      calls.push({ path, args });
      return fn(...args);
    };
  const subscription = (path: string) =>
    recorded(path, (cb: (...args: unknown[]) => void) => {
      if (!listeners.has(path)) listeners.set(path, new Set());
      listeners.get(path)?.add(cb);
      return () => listeners.get(path)?.delete(cb);
    });
  const build = (spec: Record<string, any>, over: Overrides, prefix: string): Record<string, unknown> => {
    const unknown = Object.keys(over).filter((name) => !(name in spec) && !(prefix === '' && RESERVED.has(name)));
    if (unknown.length) throw new Error(`the bridge declares no ${unknown.map((n) => prefix + n).join(', ')}; check electron/bridge`);
    const out: Record<string, unknown> = {};
    for (const [name, node] of Object.entries(spec)) {
      const path = prefix + name;
      const given = over[name];
      const method = typeof node?.kind === 'string';
      if (given === null) continue;
      if (!method) out[name] = build(node, isRecord(given) ? given : {}, `${path}.`);
      else if (given !== undefined) out[name] = typeof given === 'function' ? recorded(path, given as (...a: any[]) => unknown) : given;
      else if (node.kind === 'on') out[name] = subscription(path);
      else if (node.kind === 'send') out[name] = recorded(path, () => undefined);
      else if (node.kind === 'filePath') out[name] = recorded(path, (file: { path?: string }) => file?.path ?? '');
      else out[name] = recorded(path, async () => undefined);
    }
    return out;
  };
  const flags: Overrides = isRecord(overrides.flags) ? overrides.flags : {};
  const api = build(loadBridge(), overrides, '') as Record<string, unknown>;
  api.platform = overrides.platform ?? 'darwin';
  // left out unless a test names it: the app reads a missing key as a build with the MoPilot service
  if (overrides.mopilotService !== undefined) api.mopilotService = overrides.mopilotService;
  const flag = (name: string, fallback: (...args: any[]) => unknown) =>
    recorded(`flags.${name}`, typeof flags[name] === 'function' ? (flags[name] as (...args: any[]) => unknown) : fallback);
  api.flags = {
    isEnabled: flag('isEnabled', () => false),
    all: flag('all', () => ({})),
    onChanged: typeof flags.onChanged === 'function' ? flag('onChanged', () => undefined) : subscription('flags.onChanged'),
  };
  return Object.assign(api as unknown as NativeApi, {
    calls,
    callsTo: (path: string) => calls.filter((c) => c.path === path).map((c) => c.args),
    emit: (path: string, ...args: unknown[]) => {
      for (const cb of listeners.get(path) ?? []) cb(...args);
    },
  });
}

/** Install a fake for the rest of the test (or the file, given the test runner's `after`), and put back what was there. */
export function useFakeNative(t: { after: (fn: () => void) => void }, overrides: Overrides = {}): FakeNative {
  const fake = fakeNative(overrides);
  const previous = installNative(fake);
  t.after(() => installNative(previous));
  return fake;
}

/**
 * Install a test's own partial bridge as it is, with no defaults filled in: for a test that checks what the app does
 * when a namespace or call is missing (a preload without it), or that stood in only the calls it uses before the shared
 * fake existed. Prefer `useFakeNative`.
 */
export function installNativeStub(stub: object): void {
  installNative(stub as NativeApi);
}
