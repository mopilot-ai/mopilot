// Discover an ACP harness's explicit conformance fixture by its registered id, with no central profile registry.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export function loadMimic(id: string): Record<string, any> {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`Invalid ACP fixture id: ${id}`);
  return require(`./acp-mimics/${id}.mjs`).default;
}
