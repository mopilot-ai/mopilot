// Parse one canvas TSX module without executing it in the app's renderer.
import { transform } from 'sucrase';

export function compileCanvas(source: string) {
  return transform(source, {
    transforms: ['typescript', 'jsx', 'imports'],
    production: true,
    disableESTransforms: true,
    filePath: 'artifact.canvas.tsx',
  }).code;
}
