// Vite supplies the prebundled, offline canvas iframe runtime as a string.
declare module 'virtual:mopilot-canvas-runtime' {
  const source: string;
  export default source;
}
