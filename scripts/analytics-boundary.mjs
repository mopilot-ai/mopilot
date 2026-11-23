// Build-time boundary for optional private analytics; default artifacts must contain no private implementation.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const analyticsMode = (env) => (env.MOPILOT_PRIVATE_ANALYTICS === 'private' ? 'private' : 'none');
export const privateAnalyticsPath = /(?:^|[/\\])(?:electron|src)[/\\]private[/\\]analytics(?:[/\\]|$)/;
export const rendererAnalyticsAlias = (root, mode) => ({
  find: /^\.\/analyticsProvider$/,
  replacement: path.join(root, mode === 'private' ? 'src/private/analytics/renderer.ts' : 'src/lib/analyticsProvider.ts'),
});

/** Vite emits the mode and rejects accidental private-module imports in an OSS renderer. */
export function analyticsBoundaryPlugin(mode) {
  return {
    name: 'analytics-boundary',
    generateBundle(_options, bundle) {
      if (
        mode === 'none' &&
        Object.values(bundle).some(
          (chunk) => chunk.type === 'chunk' && Object.keys(chunk.modules).some((file) => privateAnalyticsPath.test(file)),
        )
      )
        throw new Error('An OSS renderer includes private analytics');
      this.emitFile({ type: 'asset', fileName: 'analytics-mode.json', source: JSON.stringify({ mode }) });
    },
  };
}

/** Refuse a stale renderer built in another mode before the packager copies any files. */
export function verifyAnalyticsBundle(root, mode) {
  const stamp = JSON.parse(readFileSync(path.join(root, 'dist/analytics-mode.json'), 'utf8'));
  if (stamp.mode !== mode)
    throw new Error('Renderer analytics mode differs from packaging mode; rebuild the renderer with the same environment');
}
