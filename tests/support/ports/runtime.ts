// The harness runtime port (src/store/runtime.ts) for tests: a fake whose members a test didn't give throw when called,
// or the real one, built from the harness modules as src/main.tsx builds it.
import { installRuntime, type HarnessRuntime } from '../../../src/store/runtime.ts';

/** A runtime with the given members; any other member throws when called, naming itself, instead of doing nothing. */
export function fakeRuntime(members: Partial<HarnessRuntime> = {}): HarnessRuntime {
  return new Proxy(members as HarnessRuntime, {
    get: (given, name) =>
      typeof name !== 'string' || name in given
        ? Reflect.get(given, name)
        : () => {
            throw new Error(`the harness runtime's ${name} is not stubbed`);
          },
  });
}

/** Installs a fake runtime for the test file; returns the one it replaced. */
export const installFakeRuntime = (members: Partial<HarnessRuntime> = {}) => installRuntime(fakeRuntime(members));

/**
 * Installs the real runtime, and the built-in semantic handlers: the harness modules as the app runs them. Call it after the test's mock.module calls, so a
 * harness module the test stubs is the stub here too.
 */
export async function installRealRuntime() {
  const { harnessRuntime } = await import('../../../src/session/harness/runtime.ts');
  const { registerSemanticHandlers } = await import('../../../src/session/harness/adapters/handlers.ts');
  registerSemanticHandlers();
  return installRuntime(harnessRuntime());
}
