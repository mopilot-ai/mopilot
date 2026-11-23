// Records how the production entry starts the dev pairing link.
export function startDevPairLink(runtime: unknown, name: string, dev: boolean) {
  const w = globalThis as any;
  (w.__phoneDevPairLinks ??= []).push({ runtime, name, dev, stopped: false });
  const entry = w.__phoneDevPairLinks.at(-1);
  return () => {
    entry.stopped = true;
  };
}
