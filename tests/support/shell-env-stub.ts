// One stand-in for electron/platform/env.cjs in tests that stub main's modules: no login shell is read, children get a
// fixed PATH, and the git and gh main runs itself (gitEnv, #1580) get the same.
/**
 * The stub's functions, each passed through `wrap` (mock.fn, to count calls and change them per test).
 * @param {(impl?: (...a: any[]) => any) => any} wrap
 */
export function shellEnvStub(wrap: (impl?: (...a: any[]) => any) => any) {
  return {
    init: wrap(),
    setExtraEnv: wrap(),
    which: wrap(() => null),
    whichAll: wrap(() => []),
    dirVars: wrap(() => ({})),
    childEnv: wrap(() => ({ PATH: '/bin' })),
    gitEnv: wrap(() => ({ PATH: '/bin' })),
    ready: wrap(async () => undefined),
    status: wrap(() => 'env-ok'),
  };
}
