// Main's capabilities for one chat (electron/session/caps.cjs), from its segment kind, whether it runs on a machine, the agent its record keeps (`hostAgent`, the Host's word after a switch) and its session.
import { createRequire } from 'node:module';

const { CapsService } = createRequire(import.meta.url)('../../electron/session/caps.cjs');

export interface ChatPlace {
  /** the chat runs on another machine (main's remote route owns it) */
  onMachine?: boolean;
  /** what the chat's record keeps as its Host's agent; undefined keeps none */
  hostAgent?: unknown;
}

export function mainCapsFor(kind: string, { onMachine = false, hostAgent }: ChatPlace = {}, session: any = { turn: 'running', acp: null }) {
  const config = hostAgent === undefined ? {} : { hostAgent };
  return new CapsService({
    ref: () => ({ kind, key: 'k' }),
    onMachine: () => onMachine,
    record: () => ({ meta: { config }, segments: [{ kind }] }),
    session: () => session,
    isEnabled: () => true,
    codex: async () => ({ version: '0.162.0', models: [], negotiated: { probes: {}, flags: {} } }),
    claude: { version: () => '2.1.295', probeInfo: () => ({ models: [], fastBlocked: null }), appliedOf: () => null },
    instances: () => [],
    prefs: () => ({}),
  }).get('c1');
}
