// Capability resolution lives in shared/caps.mjs (main computes it per chat; this re-exports it).
// What stays here is the window's wording: whyText turns a Why into the English line.
import type { Semantic, Why } from './adapter';
import { WHY, WHY_FALLBACK } from './copy';

export {
  POLYFILLS,
  accountGate,
  flagGate,
  modelGate,
  present,
  providerGate,
  resolveCaps,
  sessionGate,
  versionGate,
} from '../../shared/caps.mjs';
export type { CapsInput, Entry, Gate } from '../../shared/caps.mjs';

/* ------------------------------------------------------------------ */
/* Why copy: one reason · one action. The table lives in copy.ts.     */
/* ------------------------------------------------------------------ */
export const FEATURE_LABEL: Record<Semantic, string> = {
  goal: 'goals',
  plan: 'plan mode',
  review: 'code review',
  multiAgent: 'multiple agents',
  deepReasoning: 'deeper thinking',
  compact: 'compact',
  init: 'init',
  skills: 'skills',
  memory: 'memory',
  tasks: 'background tasks',
  workflows: 'workflows',
  shell: 'shell commands',
  rename: 'rename',
  fork: 'fork',
  rewind: 'editing messages',
  temporary: 'temporary chats',
  archive: 'archive',
  search: 'search',
  clear: 'clear',
  model: 'model choice',
  effort: 'reasoning effort',
  speed: 'Fast',
  permissions: 'permissions',
  mcp: 'MCP',
  status: 'status',
  feedback: 'feedback',
  logout: 'log out',
  audioInput: 'audio messages',
  voiceChat: 'voice chat',
  cloud: 'Cloud',
  textGen: 'text generation',
  computerUse: 'computer control',
  browser: 'browser control',
  dictation: 'dictation',
  nativeDictation: 'dictation with its own account',
  plugins: 'plugins',
  computerHistory: 'Computer History',
  design: 'design systems',
  momoContext: "MoMo's memory",
  artifacts: 'artifacts and designs',
  remoteControl: 'Remote Control',
};

/** `account`: what to go back to when the gateway can't do it ("Claude subscription", "ChatGPT account"). */
export type WhyVars = { label?: string; version?: string; provider?: string; feature?: string; semantic?: Semantic; account?: string };

export function whyText(why: Why, vars: WhyVars = {}): string {
  const v: Record<string, string> = {
    label: vars.label ?? 'This harness',
    version: vars.version ?? '',
    provider: vars.provider ?? 'this',
    account: vars.account ?? 'own subscription',
    feature: vars.feature ?? (vars.semantic ? FEATURE_LABEL[vars.semantic] : 'this'),
  };
  const t = WHY[why.code] ?? WHY_FALLBACK[why.layer];
  // a sentence that opens with the feature name gets a capital; labels keep their own case (dsh)
  if (t.startsWith('{feature}')) v.feature = v.feature.charAt(0).toUpperCase() + v.feature.slice(1);
  return t.replace(/\{(label|version|provider|account|feature)\}/g, (_, k) => v[k]).replace(/ {2,}/g, ' ');
}
