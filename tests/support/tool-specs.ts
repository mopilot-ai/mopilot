// The capability tool specs as plain JSON (no handlers): {name, description, inputSchema, policy}, as a harness
// adapter would list them. The capabilities register from their SPECS tables; tests read the tables this way.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
type Spec = { name?: string; description: string; inputSchema?: unknown; schema?: unknown; policy?: string };

/** Specs keyed by tool name (browser, dev preview) or a list that names each one (desktop, app-scoped). */
function plain(specs: Record<string, Spec> | Spec[]): any[] {
  const list = Array.isArray(specs) ? specs.map((s) => [s.name!, s] as const) : Object.entries(specs);
  return list.map(([name, s]) => ({
    name,
    description: s.description,
    inputSchema: JSON.parse(JSON.stringify(s.inputSchema ?? s.schema)),
    policy: s.policy,
  }));
}

// the page tools, then the deferred devtools group's (devtools/tools.cjs), in the order createBrowserTools lists them
export const browserToolSpecs = () =>
  plain({
    ...require('../../electron/capabilities/browser/hostToolSpecs.cjs').SPECS,
    ...require('../../electron/capabilities/browser/devtools/tools.cjs').DEVTOOLS_SPECS,
  });
export const previewToolSpecs = () => plain(require('../../electron/capabilities/browser/devPreview/tools.cjs').SPECS);
export const desktopToolSpecs = () => plain(require('../../electron/capabilities/tools/desktopSpecs.cjs').SPECS);
export const appToolSpecs = () => plain(require('../../electron/capabilities/tools/appScopedSpecs.cjs').SPECS);
