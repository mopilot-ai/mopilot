// The Vite plugin that runs the interface text transform over the renderer's sources (scripts/i18n/transform.mjs).
import path from 'node:path';
import { wrapInterfaceText } from './transform.mjs';

/** Where the lookups live, from a source file: relative, so it resolves the same on Windows. */
function runtimeFrom(id, root) {
  const relative = path.relative(path.dirname(id), path.join(root, 'src/lib/i18n.ts')).replaceAll('\\', '/');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

/** Runs first, while the source is still TSX: the transform reads JSX and types. */
export function i18nPlugin() {
  let root = process.cwd();
  return {
    name: 'mopilot-i18n',
    enforce: 'pre',
    configResolved(config) {
      root = config.root;
    },
    transform(code, rawId) {
      const id = rawId.split('?')[0];
      const file = path.relative(root, id).replaceAll('\\', '/');
      if (!/^src\/.*\.tsx?$/.test(file) || file === 'src/lib/i18n.ts') return null;
      const out = wrapInterfaceText(code, file, { runtime: runtimeFrom(id, root) });
      return out.code === code ? null : { code: out.code, map: null };
    },
  };
}
