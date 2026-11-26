// The renderer's core state types: routes, turns, thread runtime, attachments and pending requests. @store-slice: tests' store stub replaces it whole (tests/support/stubs.ts).

import { shareUsageDataEnabled } from '../../shared/usageData.mjs';
import { branchPrefixOf, DEFAULT_BRANCH_PREFIX, BRANCH_PREFIX_PREFS_VERSION } from '../../shared/branchPrefix.mjs';
import { isHarnessKind, RETIRED_DEFAULT_HARNESS_PREFS } from '../../shared/defaultHarness.mjs';
import { SYSTEM_LANGUAGE } from '../../shared/i18n/languages.mjs';
import type { Thread } from '../protocol/v2/Thread';
import type { ThreadItem } from '../protocol/v2/ThreadItem';
import type { ThreadTokenUsage } from '../protocol/v2/ThreadTokenUsage';
import type { Model } from '../protocol/v2/Model';
import type { TurnPlanStep } from '../protocol/v2/TurnPlanStep';
import { worktreeRootOf, projectlessFolderOf, inCodexWorktrees } from './prefFolders';
import type { AppState } from './state';
import type { Prefs } from '../../shared/model/store';
export type {
  Attachment,
  BasicDefaults,
  ChatGoal,
  ChatGoalStatus,
  Elsewhere,
  ElsewhereApp,
  PendingRequest,
  PermissionMode,
  Prefs,
  Project,
  RefusedApp,
  StatusNoteItem,
  TaskEvent,
  ThreadRuntime,
  Toast,
  TurnState,
  WakeNote,
} from '../../shared/model/store';

export type { Thread, ThreadItem, ThreadTokenUsage, Model, TurnPlanStep };

export type { Route } from './route';

/**
 * 2: MoPilot's own worktree and projectless defaults (#63).
 * 3: worktrees leave the Codex app's folder, whose cleanup deletes them under running chats.
 */
export const PREFS_VERSION = BRANCH_PREFIX_PREFS_VERSION;

export const DEFAULT_PREFS: Prefs = {
  model: null,
  effort: null,
  permission: 'default',
  serviceTier: null,
  theme: 'system',
  sendWith: 'enter',
  followUp: 'queue',
  notifyOnComplete: 'unfocused',
  notifyKinds: {},
  notifyQuietHours: null,
  showReasoning: true,
  wrapCode: false,
  defaultTerminal: 'bottom',
  fontSize: 14,
  codeFontSize: 12,
  zoomLevel: 0,
  schedulerOff: false,
  newTaskPrompt: 'ask',
  autoArchiveDays: null,
  autoApplyReviewFixes: false,
  autoContinueOnLimit: true,
  autoSwitchHarnessOnLimit: false,
  projectlessFolder: null,
  openDestination: 'finder',
  showInMenuBar: false,
  confirmClose: 'shortcut',
  fullViewDefault: false,
  bottomPanelControl: true,
  simulatorIos: true,
  simulatorAndroid: true,
  accent: null,
  bgOverride: null,
  fgOverride: null,
  fontFamily: null,
  branchPrefix: DEFAULT_BRANCH_PREFIX,
  changesScope: 'branch',
  changesLastTurnOnly: false,
  worktreeRoot: null,
  worktreeDefault: false,
  autoDeleteWorktrees: true,
  autoDeleteLimit: 15,
  keybindings: {},
  pinnedProjects: [],
  hiddenFolders: [],
  folderNames: {},
  hostFolders: {},
  hostPicks: {},
  lastNewChatHost: null,
  voice: 'cove',
  miniShortcut: false,
  hideFullAccessBanner: false,
  micDeviceId: null,
  dictationLanguage: 'auto',
  interfaceLanguage: SYSTEM_LANGUAGE,
  dictationEngine: null,
  localUrlDestination: 'in-app',
  browserFullUrl: false,
  browserTurnTrace: false,
  browserStorage: 'shared',
  browserImportPrompt: 'pending',
  browserImportSnoozes: 0,
  browserImportSnoozeUntil: 0,
  browserChannel: 'builtin',
  claudeInChrome: false,
  chromeProfileDir: '',
  downloadsDir: null,
  askWhereToSave: false,
  themePreset: null,
  voiceHotkey: null,
  importSync: true,
  visibleEfforts: null,
  sshHosts: [],
  sidebarOrganize: 'project',
  projectSort: 'custom',
  sidebarFolders: [],
  chatSort: 'updated',
  showChatHarness: false,
  chatOrder: {},
  sidebarSections: [],
  projectSection: {},
  importedSources: [],
  defaultHarness: 'codex',
  newChatStart: 'last',
  lastHarness: null,
  newChatDefault: null,
  claudeSelection: { model: null, effort: null, fast: false },
  acpBins: {},
  preferHighestCli: false,
  basicDefaults: {},
  acpMcp: {},
  claudeBin: null,
  limitAsk: {},
  autoUpdate: true,
  updateChannel: 'stable',
  shareUsageData: true,
  requestLog: true,
  welcomeDone: true,
  prefsVersion: PREFS_VERSION,
};

/** Prefs older builds saved for settings that have since been removed; dropped on load. */
const RETIRED_PREFS = [
  'language',
  'prMergeMethod',
  'forcePush',
  'draftPRs',
  'autoMerge',
  'autoMergeInstructions',
  'commitInstructions',
  'numberShortcuts',
  'pinReview',
  // off by default while it could double-run with the Codex app; replaced by schedulerOff
  'runSchedules',
  // one switch for every harness; replaced by limitAsk
  'limitFallback',
  // the default harness as two fields; replaced by defaultHarness (main moves them once: shared/defaultHarness.mjs)
  ...RETIRED_DEFAULT_HARNESS_PREFS,
  // a conversation-detail choice that had no setting and no reader (#1861)
  'conversationDetail',
];

/** Saved prefs over the defaults, without the retired keys (so they aren't written back). */
export function loadPrefs(saved: unknown): Prefs {
  const p: Record<string, unknown> = saved && typeof saved === 'object' && !Array.isArray(saved) ? { ...(saved as object) } : {};
  // the old global "offer paid access" carries over to every harness
  if (p.limitFallback === true && !('limitAsk' in p)) p.limitAsk = { codex: true, claude: true };
  for (const k of RETIRED_PREFS) delete p[k];
  if (!isHarnessKind(p.defaultHarness)) delete p.defaultHarness;
  if (p.newChatStart !== 'last' && p.newChatStart !== 'default') delete p.newChatStart;
  if (!isHarnessKind(p.lastHarness)) delete p.lastHarness;
  p.newChatDefault = newChatDefaultOf(p.newChatDefault);
  const host = p.lastNewChatHost as Partial<NonNullable<Prefs['lastNewChatHost']>> | null | undefined;
  p.lastNewChatHost =
    typeof host?.id === 'string' && host.id && host.id !== 'local' && typeof host.name === 'string'
      ? { id: host.id, name: host.name }
      : null;
  p.hostPicks = hostPicksOf(p.hostPicks);
  p.branchPrefix = branchPrefixOf(p.branchPrefix, p.prefsVersion);
  return { ...DEFAULT_PREFS, ...p, shareUsageData: shareUsageDataEnabled(p.shareUsageData) } as Prefs;
}

/** The saved fixed new-chat model and effort, or null when it is missing or malformed (a hand-edited or older file). */
function newChatDefaultOf(saved: unknown): Prefs['newChatDefault'] {
  const r = saved as { harness?: unknown; model?: unknown; effort?: unknown } | null | undefined;
  if (!r || typeof r !== 'object' || !isHarnessKind(r.harness)) return null;
  const text = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return { harness: r.harness as NonNullable<Prefs['newChatDefault']>['harness'], model: text(r.model), effort: text(r.effort) };
}

/** The saved per-machine starting picks, keeping only well-formed entries (a hand-edited or older file loses the rest). */
function hostPicksOf(saved: unknown): Prefs['hostPicks'] {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
  const out: Prefs['hostPicks'] = {};
  for (const [id, v] of Object.entries(saved as Record<string, unknown>)) {
    const r = v as { agent?: unknown; model?: unknown; effort?: unknown } | null;
    if (!id || typeof r?.agent !== 'string' || !r.agent) continue;
    out[id] = {
      agent: r.agent,
      ...(typeof r.model === 'string' && r.model ? { model: r.model } : {}),
      ...(typeof r.effort === 'string' && r.effort ? { effort: r.effort } : {}),
    };
  }
  return out;
}

/** A fresh draft starts on the last device picked in Run on, using the last folder there. */
export function rememberedNewChatHost(prefs: Prefs, path?: string): AppState['newChatHost'] {
  const host = prefs.lastNewChatHost;
  if (!host) return null;
  const folder = prefs.hostFolders?.[host.id];
  return {
    id: host.id,
    name: host.name,
    path: path || (typeof folder === 'string' ? folder : ''),
    remembered: true,
    before: { projectId: 'none', cwd: null },
  };
}

// where worktrees and projectless chats go, from the prefs (src/store/prefFolders.ts)
export { worktreeRootOf, projectlessFolderOf, inCodexWorktrees };

/**
 * What to write into saved prefs older than PREFS_VERSION, or null when they are current. Builds
 * before version 2 didn't save every pref, so a saved branchPrefix without a version marks an
 * existing profile: it keeps its custom prefix and ~/Documents/Codex. Version 4 replaces the old
 * codex/ default with mopilot/ for every harness. A worktree folder in the Codex
 * app's own folder (where those profiles kept them) goes back to the default: the app deletes
 * worktrees there. A new profile only gets the version stamped and uses the new defaults.
 */
export function defaultsPatch(saved: unknown, legacy: { home: string; codexHome: string }): Partial<Prefs> | null {
  const p = saved && typeof saved === 'object' && !Array.isArray(saved) ? (saved as Record<string, unknown>) : {};
  if (typeof p.prefsVersion === 'number' && p.prefsVersion >= PREFS_VERSION) return null;
  const patch: Partial<Prefs> = { prefsVersion: PREFS_VERSION };
  if (p.branchPrefix === 'codex/') patch.branchPrefix = branchPrefixOf(p.branchPrefix, p.prefsVersion);
  if (typeof p.prefsVersion !== 'number' && 'branchPrefix' in p && !p.projectlessFolder)
    patch.projectlessFolder = `${legacy.home}/Documents/Codex`;
  if (inCodexWorktrees(p.worktreeRoot, legacy.home, legacy.codexHome)) patch.worktreeRoot = null;
  return patch;
}
