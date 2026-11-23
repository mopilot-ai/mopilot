// Shared sandboxed documents for agent-authored HTML and compiled canvases, plus local HTML loading.

import { absPath, isAbsolutePath } from './paths';

// A visualization is agent-authored HTML. Run it in an opaque-origin sandbox,
// without the app's preload, filesystem access, top navigation or network APIs.
const CDN =
  'https://cdnjs.cloudflare.com https://esm.sh https://cdn.jsdelivr.net https://unpkg.com https://fonts.googleapis.com https://fonts.gstatic.com https://fonts.bunny.net';
const CSP = `default-src 'none'; script-src 'unsafe-inline' ${CDN}; style-src 'unsafe-inline' ${CDN}; img-src data: blob: ${CDN}; font-src data: ${CDN}; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;

export function previewDocument(html: string, dark: boolean) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    :root { color-scheme: ${dark ? 'dark' : 'light'};
      --background: light-dark(#fff,#1b1b1b); --foreground: light-dark(#202020,#ececec);
      --card: var(--background); --card-foreground: var(--foreground);
      --popover: var(--background); --popover-foreground: var(--foreground);
      --muted: light-dark(#f5f5f5,#252525); --muted-foreground: light-dark(#6d6d6d,#aaa);
      --secondary: var(--muted); --secondary-foreground: var(--foreground);
      --accent: var(--muted); --accent-foreground: var(--foreground);
      --primary: light-dark(#287746,#91cda5); --primary-foreground: var(--background);
      --border: light-dark(#e5e5e5,#393939); --input: var(--border); --ring: var(--primary);
      --blue: light-dark(#2563eb,#93b4ff); --orange: light-dark(#b45309,#fdba74);
      --green: var(--primary); --red: light-dark(#b91c1c,#fca5a5);
      --purple: light-dark(#7e22ce,#d8b4fe); --yellow: light-dark(#a16207,#fde047); --destructive: var(--red);
    }
    * { box-sizing: border-box; } body { margin: 0; padding: 12px; background: var(--background); color: var(--foreground); font: 14px/1.5 system-ui,sans-serif; }
    button,input,select,textarea { font: inherit; color: inherit; } button { cursor: pointer; }
    .card { padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--card); color: var(--card-foreground); }
    .btn,.form-control,.form-select { padding: 8px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--background); }
    .btn-primary { background: var(--primary); color: var(--primary-foreground); }
    .text-muted { color: var(--muted-foreground); } .text-small { font-size: 12px; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  </style></head><body>${html}</body></html>`;
}

export type LoadedVisualization = { path: string; html: string | null; error: string | null };

/** Read through the host boundary; never let an invalid path reach filesystem IPC. */
export async function loadVisualization(
  path: string | undefined,
  cwd: string | null | undefined,
  readText: (path: string) => Promise<string | null>,
): Promise<LoadedVisualization> {
  const resolved = path ? absPath(path, cwd) : '';
  const result = (html: string | null, error: string | null): LoadedVisualization => ({ path: resolved, html, error });
  if (!isAbsolutePath(resolved) || !/\.html?$/i.test(resolved)) return result(null, 'Preview requires a local HTML file.');
  try {
    const html = await readText(resolved);
    if (html === null) return result(null, 'Preview file is unavailable.');
    if (html.length > 1_000_000) return result(null, 'Preview file is too large.');
    return result(html, null);
  } catch {
    return result(null, 'Unable to read preview file.');
  }
}

// Compiled canvases are self-contained; unlike HTML files, they never read same-folder assets.
export const CANVAS_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const script = (code: string) => code.replace(/<\/script/gi, '<\\/script');
export function canvasDocument(code: string, runtime: string, input: { id: string; dark: boolean; state: Record<string, unknown> }) {
  const payload = JSON.stringify(input).replace(/</g, '\\u003c');
  const document = previewDocument(
    `<style>
    :root { --canvas-body: 14px; --canvas-small: 12px; --canvas-h1: 24px; --canvas-h2: 19px; --canvas-h3: 16px; }
    .canvas-button,.canvas-input { border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; background: var(--background); }
    .canvas-button.primary { background: var(--primary); color: var(--primary-foreground); }
    .canvas-button.ghost { border-color: transparent; background: transparent; }
    .canvas-card-header { display: flex; align-items: center; gap: 8px; width: 100%; padding: 12px 16px; font-weight: 600; border: 0; background: transparent; }
    [data-sticky-header] > .canvas-card-header { position: sticky; top: 0; background: var(--background); }
    .canvas-disclosure { border: 0; background: transparent; padding: 8px 0; font-weight: 600; text-align: left; }
    button:disabled,input:disabled,select:disabled,textarea:disabled { opacity: .5; cursor: default; }
    a { overflow-wrap: anywhere; } pre { white-space: pre-wrap; }
  </style><div id="canvas-root"></div><script type="application/json" id="canvas-input">${payload}</script>
  <script>${script(runtime)}</script><script>
    (function(React, require) {
      const module = { exports: {} }; const exports = module.exports;
      try {
        ${script(code)}
        window.MoPilotCanvas.mount(module.exports.default);
      } catch (error) { window.MoPilotCanvas.failure(error); }
    })(window.MoPilotCanvas.React, window.MoPilotCanvas.require);
  </script>`,
    input.dark,
  );
  return document.replace(/(<meta http-equiv="Content-Security-Policy" content=")[^"]*/, `$1${CANVAS_CSP}`);
}
