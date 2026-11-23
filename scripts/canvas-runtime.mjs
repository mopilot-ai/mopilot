// Bundle the canvas compatibility runtime into an offline script for the opaque file-preview iframe.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

export const CANVAS_RUNTIME = 'virtual:mopilot-canvas-runtime';

export async function bundleCanvasRuntime() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/lib/canvas/entry.ts', import.meta.url))],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    metafile: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  return { code: result.outputFiles[0].text, inputs: Object.keys(result.metafile.inputs) };
}

export function canvasRuntimePlugin() {
  return {
    name: 'sandboxed-canvas-runtime',
    resolveId(id) {
      return id === CANVAS_RUNTIME ? `\0${CANVAS_RUNTIME}` : null;
    },
    async load(id) {
      if (id !== `\0${CANVAS_RUNTIME}`) return null;
      const result = await bundleCanvasRuntime();
      for (const input of result.inputs) this.addWatchFile(input);
      return `export default ${JSON.stringify(result.code)};`;
    },
  };
}
