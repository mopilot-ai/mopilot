// The harness families shared code tells apart (Codex, Claude Code, and the basic tier over ACP) and what
// each one does differently, as data. src/store and src/lib read a trait here or pick a family's entry
// from a Record<HarnessFamily, …>, never a harness name, so a new family is a type error until it answers.
import { currentNativeId, firstTierKind, ownerOf } from './ownership';
import { acpHarnessOf, HARNESS_IDS, isAcpThread, type HarnessId, type Segment } from './types';
import type { HarnessKind } from './adapter';
import { PLAN_SIZES, planUnitsOf } from '../../shared/remainingCapacity.mjs';

/** Codex, Claude Code, or any basic harness over ACP. */
export type HarnessFamily = HarnessId | 'acp';

/** A pending destination owns the composer's basic-harness controls; otherwise the current selection does. */
export const pendingBasic = (target: HarnessKind | null | undefined, current: string | null): string | null =>
  target ? acpHarnessOf(target) : current;

/**
 * The harness kind a first-tier pick or a basic harness id names, or null while neither has resolved (a chat whose
 * segments haven't loaded): never 'acp:null' (#2862).
 */
export const harnessKindFrom = (firstTier: HarnessId | null, basic: string | null): HarnessKind | null =>
  firstTier ?? (basic ? `acp:${basic}` : null);

/** The family of a native session whose first-tier record says `harness`: ACP when the session is a basic-tier one. */
export const harnessFamily = (harness: HarnessKind, nativeId: string | null | undefined): HarnessFamily =>
  isAcpThread(nativeId) ? 'acp' : (firstTierKind(harness) ?? 'acp');
/** The family a native session belongs to, from its own record. */
export const nativeFamily = (nativeId: string): HarnessFamily => harnessFamily(ownerOf(nativeId), nativeId);
/**
 * The family of a chat's current segment: a basic harness's session (by its id), else the segment's first-tier harness.
 * A basic chat has no first-tier harness: code that needs Codex's or Claude's account, selection or limits narrows the
 * family (firstTierOf) and says what a basic chat does instead (lint/rules/family-collapse.grit).
 */
export function currentFamily(segments: Segment[] | null | undefined, chatId: string): HarnessFamily {
  if (isAcpThread(currentNativeId(segments, chatId))) return 'acp';
  return segments?.length ? (firstTierKind(segments[segments.length - 1].harness) ?? 'codex') : ownerOf(chatId);
}
/** The first-tier harness a family is, or null for a basic harness: it has no Codex or Claude account, selection or limits. */
export const firstTierOf = (family: HarnessFamily): HarnessId | null => (family === 'acp' ? null : family);
/** The other first-tier harness: where a chat can continue when this one runs out. */
export const otherFirstTier = (h: HarnessId): HarnessId => HARNESS_IDS.find((x) => x !== h)!;

export interface HarnessTraits {
  /** the running-activity look: the accent dot spinner every harness uses now, or the older shimmering header and step label */
  activity: 'dots' | 'shimmer';
  /** Feedback and thumbs go to OpenAI, with the chat's app-server thread attached */
  feedbackUpload: boolean;
  /** where a reply's thumbs up or down goes, so every harness has somewhere: 'upload' sends it with Feedback (feedbackUpload),
   *  'usage' counts it as a usage event while usage data is shared, and nothing about the chat goes to OpenAI */
  rating: 'upload' | 'usage';
  /** the harness keeps a goal of its own, read when the chat opens (Codex's thread/goal) */
  readsGoalOnOpen: boolean;
  /** the harness lists the commands a chat left running in the background (Codex's background terminals) */
  backgroundTerminals: boolean;
  /** editing a message rewinds to a file checkpoint the harness wrote, so a message without one can't be edited */
  editNeedsCheckpoint: boolean;
  /** where the / menu's skills come from: Codex's skills/list, the harness's own catalog, or its command list */
  skills: 'codexSkillList' | 'catalog' | 'commands';
  /** what its Remote Control links: a chat's own session (Claude Code to claude.ai), or the whole computer to the user's devices (Codex) */
  remoteControl: 'chat' | 'computer';
  /** realtime voice runs on this harness; a chat on another one starts a new chat here for it */
  realtimeVoice: boolean;
  /** its sessions run Claude in Chrome themselves */
  nativeChrome: boolean;
  /** a temporary chat picked on a basic harness runs here instead (it keeps the chat off disk) */
  temporaryForBasic: boolean;
  /** its code review reports findings through ReportFindings: a fix request asks for their outcomes the same way, and a
   *  review runs again as /code-review at its level */
  reportsFindings: boolean;
  /** what its context snapshot holds (electron/context): 'full' when the harness says what fills its window (Claude Code's
   *  get_context_usage, read when its turns end and on request), 'tokens' when it reports token counts only */
  contextBreakdown: 'full' | 'tokens';
  /** why MoMo can't run on this harness's API-key account, or null when it can (#2308: MoMo's Codex app-server signs in
   *  only with a ChatGPT sign-in); its brain pickers show it on such an account */
  momoKeyRefused: string | null;
  /** the model a new MoMo brain starts on (#2527): a capable everyday tier, not the strongest; null: the harness's own default
   *  (one of `models`, or none for a harness whose model is a session option) */
  everydayModel: <M extends ModelChoice>(models: M[]) => M | null;
  /** how much a plan holds next to the smallest paid one (Claude Pro = 1, Max 5× = 5, Max 20× = 20), from the plan's name as
   *  the account view says it; null: not known. MoMo's default brain compares what accounts have left in these units. */
  planUnits: (plan: string | null) => number | null;
}

/** A model as the everyday-tier trait reads it. */
export type ModelChoice = { id: string; label: string; isDefault?: boolean };
const defaultModel = <M extends ModelChoice>(models: M[]) => models.find((m) => m.isDefault) ?? models[0] ?? null;
/** A family's plan sizes (shared/remainingCapacity.mjs, which main's account drivers read too, so both size a plan alike). */
const unitsOf = (sizes: Readonly<Record<string, number>>) => (plan: string | null) => planUnitsOf(sizes, plan);

export const HARNESS_TRAITS: Record<HarnessFamily, HarnessTraits> = {
  codex: {
    activity: 'dots',
    feedbackUpload: true,
    rating: 'upload',
    readsGoalOnOpen: true,
    backgroundTerminals: true,
    editNeedsCheckpoint: false,
    skills: 'codexSkillList',
    remoteControl: 'computer',
    realtimeVoice: true,
    nativeChrome: false,
    temporaryForBasic: false,
    reportsFindings: false,
    contextBreakdown: 'tokens',
    momoKeyRefused: 'MoMo needs a ChatGPT sign-in on Codex',
    // Codex ships its everyday model as the list's default; the strongest is a separate pick
    everydayModel: defaultModel,
    planUnits: unitsOf(PLAN_SIZES.codex),
  },
  claude: {
    activity: 'dots',
    feedbackUpload: false,
    rating: 'usage',
    readsGoalOnOpen: false,
    backgroundTerminals: false,
    editNeedsCheckpoint: true,
    skills: 'catalog',
    remoteControl: 'chat',
    realtimeVoice: false,
    nativeChrome: true,
    temporaryForBasic: true,
    reportsFindings: true,
    contextBreakdown: 'full',
    momoKeyRefused: null,
    // Sonnet: capable and far lighter on a plan than Opus; any other list falls back to its default
    everydayModel: (models) => models.find((m) => /sonnet/i.test(m.id) || /sonnet/i.test(m.label)) ?? defaultModel(models),
    planUnits: unitsOf(PLAN_SIZES.claude),
  },
  // a basic harness: its goals, reviews and compaction are commands it lists (main's caps), its skills too
  acp: {
    activity: 'dots',
    feedbackUpload: false,
    rating: 'usage',
    readsGoalOnOpen: false,
    backgroundTerminals: false,
    editNeedsCheckpoint: false,
    skills: 'commands',
    remoteControl: 'chat',
    realtimeVoice: false,
    nativeChrome: false,
    temporaryForBasic: false,
    reportsFindings: false,
    // usage_update (used, size, cost) and each prompt's usage: token counts, no categories
    contextBreakdown: 'tokens',
    momoKeyRefused: null,
    // its model is a session option the chat's own menu sets: a brain names none
    everydayModel: () => null,
    planUnits: () => null,
  },
};

/** What the harness's Remote Control links, by a chat's harness kind: a basic harness has none, and its row is greyed whatever this says. */
export const remoteControlScope = (kind: HarnessKind): 'chat' | 'computer' => {
  const tier = firstTierKind(kind);
  return tier ? HARNESS_TRAITS[tier].remoteControl : 'chat';
};

/** The first-tier harness realtime voice runs on. */
export const VOICE_HARNESS: HarnessId = HARNESS_IDS.find((h) => HARNESS_TRAITS[h].realtimeVoice)!;
/** A temporary chat can't be kept off disk by a basic-tier harness: picked there, it runs on this one (RoutingChip says so). */
export const TEMPORARY_BASIC_HARNESS: HarnessId = HARNESS_IDS.find((h) => HARNESS_TRAITS[h].temporaryForBasic)!;

/**
 * The Codex thread a chat has, whatever segment it is on now: switching back to Codex resumes it
 * (electron/session/switch.cjs), so it stays the chat's. The account relay knows the chat by it.
 * null: the chat has never been on Codex.
 */
export function codexThreadOf(segments: Segment[] | null | undefined, chatId: string): string | null {
  if (!segments?.length) return currentFamily(segments, chatId) === 'codex' ? chatId : null;
  for (let i = segments.length - 1; i >= 0; i--) if (segments[i].harness === 'codex') return segments[i].nativeId;
  return null;
}
