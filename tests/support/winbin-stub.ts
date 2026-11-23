// One stand-in for electron/platform/winbin.cjs in tests that stub main's modules: launches pass through unchanged, a stand-in
// child never leads a process group (so no made-up pid reaches process.kill(-pid)), and a stop only marks the child.
/**
 * The stub's functions, each passed through `wrap` (mock.fn, to count calls).
 * @param {(impl: (...a: any[]) => any) => any} [wrap]
 */
export function winbinStub(wrap: (impl: (...a: any[]) => any) => any = (impl) => impl) {
  return {
    windowsCandidates: wrap(() => []),
    spawnArgs: wrap((command: string, args: string[], options: any) => [command, args, options]),
    spawnGroup: wrap((spawn: any, command: string, args: string[], options: any) => spawn(command, args, options)),
    killTree: wrap((child: any) => {
      if (child) child.stopped = true;
    }),
    endGroup: wrap(() => false),
  };
}
