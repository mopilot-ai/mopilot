// A counter a test can read to see what redrew: a component calls `probe('name')` while it renders; nothing happens unless a test installed `globalThis.__momoRenderProbe`.
export function probe(name: string) {
  (globalThis as { __momoRenderProbe?: (name: string) => void }).__momoRenderProbe?.(name);
}
