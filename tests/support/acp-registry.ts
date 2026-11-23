// Valid registry metadata and isolated storage for tests of the production registry services.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registryAgent } from '../../shared/acpRegistry.mjs';

export const rawAgent = (id = 'example', version = '1.2.3') => ({
  id,
  name: `Agent ${id}`,
  version,
  website: 'https://example.com/docs',
  distribution: { npx: { package: `@example/${id}`, args: ['--acp'] } },
});
export const agent = (id = 'example', version = '1.2.3') => registryAgent(rawAgent(id, version));
export const directory = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-registry-'));
export const response = (agents: unknown[], status = 200) =>
  ({ ok: status === 200, status, text: async () => JSON.stringify({ agents }) }) as Response;
export const which = (name: string) => `/tools/${name}`;
export async function fakeInstall({ stage }: { stage: string }) {
  const program = path.join(stage, 'agent');
  fs.writeFileSync(program, 'agent');
  return { program, prefix: [], args: ['--acp'], env: { AGENT_HOME: stage } };
}
