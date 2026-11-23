// PDF.js resources ship beside the renderer and are served from the same local path during development.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOURCE = path.join(ROOT, 'node_modules/pdfjs-dist');
export const PDF_RESOURCE_FOLDERS = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];

export function copyPdfAssets(output = path.join(ROOT, 'dist'), source = SOURCE) {
  const destination = path.join(output, 'preview/pdf');
  fs.mkdirSync(destination, { recursive: true });
  for (const folder of PDF_RESOURCE_FOLDERS) fs.cpSync(path.join(source, folder), path.join(destination, folder), { recursive: true });
}

export function pdfResource(request, source = SOURCE) {
  const match = /^\/(cmaps|standard_fonts|wasm|iccs)\/([A-Za-z0-9_.-]+)$/.exec(request.split('?')[0]);
  if (!match || match[2] === '.' || match[2] === '..') return null;
  const file = path.join(source, match[1], match[2]);
  const type = file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
  return { file, type };
}

export function pdfAssetsPlugin() {
  return {
    name: 'local-pdf-resources',
    writeBundle() {
      copyPdfAssets();
    },
    configureServer(server) {
      server.middlewares.use('/preview/pdf', (request, response, next) => {
        const resource = pdfResource(request.url);
        if (!resource) return next();
        fs.readFile(resource.file, (error, bytes) => {
          if (error) {
            response.statusCode = 404;
            response.end();
            return;
          }
          response.setHeader('Content-Type', resource.type);
          response.end(bytes);
        });
      });
    },
  };
}
