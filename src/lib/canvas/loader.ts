// Load the parser and bundled iframe runtime only when a canvas preview is opened.
/// <reference path="./virtual.d.ts" />
export async function loadCanvasPreview() {
  const [runtime, compiler] = await Promise.all([import('virtual:mopilot-canvas-runtime'), import('./compile')]);
  return { runtime: runtime.default, compile: compiler.compileCanvas };
}
