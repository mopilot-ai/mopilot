import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { devServerOptions } from './scripts/dev-options.mjs';
import { pdfAssetsPlugin } from './scripts/pdf-assets.mjs';
import { generateCatalog } from './scripts/harness-catalog.mjs';
import { canvasRuntimePlugin } from './scripts/canvas-runtime.mjs';
import { i18nPlugin } from './scripts/i18n/vitePlugin.mjs';
import { analyticsMode, analyticsBoundaryPlugin, rendererAnalyticsAlias } from './scripts/analytics-boundary.mjs';

generateCatalog();

export default defineConfig({
  resolve: { alias: [rendererAnalyticsAlias(process.cwd(), analyticsMode(process.env))] },
  base: './',
  plugins: [i18nPlugin(), react(), pdfAssetsPlugin(), canvasRuntimePlugin(), analyticsBoundaryPlugin(analyticsMode(process.env))],
  server: devServerOptions(),
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 4000 },
});
