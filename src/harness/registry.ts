// Static facts about every harness MoPilot knows. Codex and Claude Code are first tier; the rest
// run through the one generic ACP adapter with a quirks file each.
import { ownTable } from '../../shared/ownTable.mjs';
import { HARNESS_INSTALL } from '../../shared/harnessInstall.mjs';
import { ACP_CATALOG, ACP_PUBLIC_IDS, catalogResume, registerRegistryAgents } from '../../shared/harnessCatalog.mjs';
import type { NativeAcpDescriptor } from '../../shared/harnessCatalog.mjs';
import { acpSessionOf } from './acpSessions';
import type { HarnessKind, StaticInfo } from './adapter';
import { HARNESS_LABEL, acpHarnessOf, cliSessionId, isAcpThread } from './types';
import { ownerOf } from './ownership';
import { hostFamilyOfHarness } from '../../shared/host/chatIds.mjs';

const basic = (o: NativeAcpDescriptor): StaticInfo => ({
  kind: `acp:${o.id}`,
  label: o.label,
  vendor: o.vendor,
  tier: 'basic',
  channel: 'acp',
  detect: { bins: o.bins },
  install: o.install,
  versions: { min: '0.0.0', knownBad: [], tested: o.tested ?? [] },
  wires: [],
  instructionsFiles: o.instructionsFiles ?? [],
  skillRoots: o.skillRoots ?? [],
  docsUrl: o.docsUrl,
  dataNotes: o.dataNotes ?? [],
  resumeCommand: (id) => catalogResume(o.id, id),
  quirks: o.id,
  privacyDefaults: o.acp.privacyDefaults,
  admission: {
    requireToolHandshake: true,
    handshakeTimeoutMs: o.acp.admission.handshakeTimeoutMs,
    ...(o.privacyGateCommand ? { privacyGate: o.privacyGateCommand } : {}),
  },
});

export const REGISTRY: Record<string, StaticInfo> = ownTable({
  codex: {
    kind: 'codex',
    label: HARNESS_LABEL.codex,
    vendor: 'OpenAI',
    subscription: 'ChatGPT account',
    subscriptionPlans: 'ChatGPT Plus, Pro, Business, Edu or Enterprise',
    tier: 'first',
    channel: 'app-server',
    detect: { bins: ['codex'] },
    install: HARNESS_INSTALL.codex,
    versions: { min: '0.162.0-alpha.17.2', knownBad: [], tested: ['0.162.0-alpha.17.2'] },
    wires: ['responses'],
    instructionsFiles: ['AGENTS.md'],
    skillRoots: ['~/.codex/skills', '.codex/skills'],
    docsUrl: 'https://developers.openai.com/codex',
    dataNotes: ['Chats are stored by Codex under ~/.codex/sessions'],
    resumeCommand: (id) => `codex resume ${id}`,
    quirks: 'codex',
  },
  claude: {
    kind: 'claude',
    label: HARNESS_LABEL.claude,
    vendor: 'Anthropic',
    subscription: 'Claude subscription',
    subscriptionPlans: 'Claude Pro, Max, Team or Enterprise',
    tier: 'first',
    channel: 'agent-sdk',
    detect: { bins: ['claude'] },
    install: HARNESS_INSTALL.claude,
    versions: { min: '2.1.295', knownBad: [], tested: ['2.1.295', '2.1.296'] },
    wires: ['anthropic'],
    instructionsFiles: ['CLAUDE.md'],
    skillRoots: ['~/.claude/skills', '.claude/skills'],
    docsUrl: 'https://docs.claude.com/en/docs/claude-code/overview',
    dataNotes: ['Chats are stored by Claude Code under ~/.claude/projects'],
    resumeCommand: (id) => `claude --resume ${id}`,
    quirks: 'claude',
  },
  ...Object.fromEntries(ACP_PUBLIC_IDS.map((id) => [`acp:${id}`, basic(ACP_CATALOG[id])])),
});

/** Adopt main's installed registry contracts before any window renders the harnesses that use them. */
export function registerInstalledRegistryHarnesses(list: { descriptor?: NativeAcpDescriptor }[]) {
  const agents = list.flatMap((item) => (item.descriptor?.registry ? [item.descriptor.registry] : []));
  for (const descriptor of registerRegistryAgents(agents)) REGISTRY[`acp:${descriptor.id}`] = basic(descriptor);
}

/** The registry key of the harness a native session belongs to: 'codex', 'claude' or 'acp:<id>'. */
export const harnessKindOf = (nativeId: string): string => (isAcpThread(nativeId) ? `acp:${acpHarnessOf(nativeId)}` : ownerOf(nativeId));
/** Codex's thread projectId is native; Claude and ACP carry the local project id. */
export const threadProjectIdField = (nativeId: string): 'id' | 'codexId' => (harnessKindOf(nativeId) === 'codex' ? 'codexId' : 'id');
const resumeIn = (kind: string, id: string): string | null => (id ? (REGISTRY[kind]?.resumeCommand(id) ?? null) : null);
/** The session id main records for a chat on a machine (electron/host/remoteChats.cjs ensureSession): a place, not an agent's session. */
const HOST_SESSION = 'host:';
/** The shell command that resumes a native session in its harness's own CLI, or null when it has none. */
export const resumeCommandFor = (nativeId: string): string | null => {
  // a Claude Code or Codex chat on a machine is drawn as an ACP chat whose uuid is the agent's own session id there: the command is that agent's, run on the machine
  const family = hostFamilyOfHarness(acpHarnessOf(nativeId) ?? '');
  if (family) return resumeIn(family, cliSessionId(nativeId));
  // a basic harness's CLI knows the chat by the agent's own session id, not MoPilot's key; none known yet: no command
  const id = isAcpThread(nativeId) ? acpSessionOf(nativeId) : cliSessionId(nativeId);
  // a basic agent's chat on a machine keeps only the Host's placeholder (`host:<machine>`), which no CLI resumes
  return id && !id.startsWith(HOST_SESSION) ? resumeIn(harnessKindOf(nativeId), id) : null;
};
/** What the harness a native session belongs to is called ('Codex', 'Claude Code', 'Kimi Code'). */
export const harnessLabelOf = (nativeId: string): string =>
  hostFamilyLabel(acpHarnessOf(nativeId) ?? '') ?? REGISTRY[harnessKindOf(nativeId)]?.label ?? (acpHarnessOf(nativeId) || 'Assistant');
/** The agent a chat's ACP harness name stands for when it runs Claude Code or Codex on a machine ('host-claude' is Claude Code), else null. */
export const hostFamilyLabel = (harness: string): string | null => {
  const family = hostFamilyOfHarness(harness);
  return family ? HARNESS_LABEL[family] : null;
};

export const harnessInfo = (kind: HarnessKind): StaticInfo | null => REGISTRY[kind] ?? null;
export const harnessesByTier = (tier: StaticInfo['tier']) => Object.values(REGISTRY).filter((h) => h.tier === tier);
