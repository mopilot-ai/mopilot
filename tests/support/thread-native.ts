// A stand-in for the preload bridge (`window.native`) for thread component tests. Every path is a
// callable that resolves to undefined (and can also be called as an unsubscribe); tests assign the
// pieces they care about, e.g. `native.computer = { stop: (id) => calls.push(id) }`, and read
// `calls` for any other bridge call made through the stand-in.
import { window } from './dom.ts';
import { installNativeStub } from './ports/native.ts';

export const calls: { path: string; args: unknown[] }[] = [];

function stub(path: string): any {
  const fn = (...args: unknown[]) => {
    calls.push({ path, args });
    return stub(`${path}()`);
  };
  const overrides: Record<string | symbol, unknown> = {};
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop in overrides) return overrides[prop];
      if (prop === 'then' || prop === 'catch' || prop === 'finally') {
        if (!path.endsWith('()')) return undefined;
        const done = Promise.resolve(undefined);
        return (done as any)[prop].bind(done);
      }
      if (typeof prop === 'symbol') return undefined;
      return (overrides[prop] = stub(`${path}.${prop}`));
    },
    set(_t, prop, value) {
      overrides[prop] = value;
      return true;
    },
  });
}

export const native: any = stub('native');
(window as any).native = native;
// the port the components read (src/lib/native.ts), as src/lib/nativeInstall.ts installs window.native
installNativeStub(native);
native.platform = 'darwin';
// flags read through useSyncExternalStore need a stable answer: every flag off
native.flags = { isEnabled: () => false, onChanged: () => () => {} };
