// Typed preload bridge binding and public contracts; namespaces augment NativeApi from src/lib/native/<namespace>.ts.
import type { FlagKey } from './flags';
export type {
  CodexEvent,
  CodexItem,
  CodexNegotiated,
  ClaudeApiKeyInfo,
  ClaudeDetect,
  ClaudeModelInfo,
  ClaudeSlashCommand,
  ClaudeCatalog,
  ClaudeDesignLoginEvent,
  ClaudeSessionOpts,
  ClaudeSessionInfo,
  ClaudeEvent,
  BasicHarnessStatus,
  AcpSessionState,
  AcpConfigOption,
  AcpCatalog,
  AcpSessionUpdate,
  AcpEvent,
} from './native/contracts/harnesses';
export type {
  AccountLimits,
  ManagedAccount,
  AccountsState,
  ClaudeManagedAccount,
  ClaudeAccountsState,
  ClaudeAccountsEvent,
  AccountsEvent,
  Billing,
  ProviderProfile,
  Instance,
  MoPilotModelCaps,
  MoPilotStatus,
} from './native/contracts/identity';
export type {
  SiteGrant,
  ErrandAllowance,
  SiteBrowser,
  WebPermissionSite,
  ChromeLinkEntry,
  ChromeLinkResult,
  PairedBrowser,
  BrowserUseResource,
  BrowserUseDecision,
  BrowserUsePref,
  BrowserUseState,
  ChromeState,
  BrowserSuggestion,
  BrowserBookmark,
  ImportKind,
  ImportSource,
  ImportSite,
  ImportKindResult,
  ImportFailure,
  ImportStarted,
  ImportFinished,
  ImportedData,
  BrowserPageEvent,
  BrowserPageDialog,
  PaneLayer,
  BrowserViewState,
  BrowserViewEvent,
  BrowserViewApi,
  BrowserRemoteApi,
  BrowserRemoteFrame,
  BrowserRemoteInput,
  AgentTabView,
  ClaudeSiteState,
  LoginFillStatus,
  LoginAssistEvent,
  CredentialRequestView,
  CredentialAnswer,
} from './native/contracts/browser';
export type {
  NativeSetupAction,
  CapabilityHealthSurface,
  NativeSurfaceStatus,
  NativeAvailabilityStatus,
  ComputerLevel,
  ComputerPermission,
  ComputerGrant,
  ComputerStatus,
  SageAccessLevel,
  SageApprovalParams,
  SiteRiskView,
  DesktopTier,
  DesktopAccessApp,
  SageApprovalAnswer,
  MomoActionParams,
  MomoActionScope,
} from './native/contracts/control';
export type {
  ManagedWorktree,
  WorktreeCopy,
  GitInfo,
  BranchList,
  GitStatusFile,
  NativeMenuItem,
  FileMatch,
  LocalProject,
  MigrationStatus,
  MigrationCounts,
  MigrationReport,
  ProjectsSnapshot,
  PtySpawnOptions,
  PtyEvent,
  LocalSpeechStatus,
  LocalSpeechFailure,
  CloudEnv,
  CloudTask,
  UpdateState,
  ExitGateRequest,
} from './native/contracts/platform';
export type { MomoActivityItem, MomoBrain, MomoBrainChange, MomoMainChatInfo, MomoPreviousChat } from './native/contracts/momoChat';

/** window.native: the preload's own keys here; each namespace merges in from src/lib/native/<namespace>.ts (docs/code-quality.md). */
export interface NativeApi {
  /** process.platform of the main process ('darwin', 'win32', …) */
  platform: string;
  /** false in a build without the MoPilot service (the open-source edition); absent in a test's stand-in, which has it */
  mopilotService?: boolean;
  flags: {
    isEnabled(key: FlagKey): boolean;
    all(): Record<string, boolean>;
    onChanged(cb: (snap: Record<string, boolean>) => void): () => void;
  };
}

declare global {
  interface Window {
    native: NativeApi;
  }
}

let installed: NativeApi | null = null;

/**
 * Put the bridge behind `native` (docs/architecture/modularization.md §2, the native port): src/lib/nativeInstall.ts installs
 * window.native before any other module runs, and a test installs its fake (tests/support/ports/native.ts); nothing else
 * reads window.native.
 * `null` takes it out again. Returns the bridge it replaced, so a test can put that one back.
 */
export function installNative(api: NativeApi | null): NativeApi | null {
  const previous = installed;
  installed = api;
  return previous;
}

/** The installed bridge, or null where none is (tooling, a test without one): for a reader that does without it. */
export const installedNative = (): NativeApi | null => installed;

/** The installed bridge. Before src/lib/nativeInstall.ts (or a test) installs one, a use says so instead of reading a global. */
const current = (): NativeApi => {
  if (!installed) throw new Error('The native bridge is not installed: src/lib/nativeInstall.ts installs window.native first.');
  return installed;
};

/** The bridge through the port: each use reads what is installed at that moment, so nothing holds an earlier one. */
export const native: NativeApi = new Proxy({} as NativeApi, {
  get: (_target, key) => Reflect.get(current(), key),
  set: (_target, key, value) => Reflect.set(current(), key, value),
  has: (_target, key) => Reflect.has(current(), key),
  deleteProperty: (_target, key) => Reflect.deleteProperty(current(), key),
  ownKeys: () => Reflect.ownKeys(current()),
  getOwnPropertyDescriptor: (_target, key) => {
    const own = Reflect.getOwnPropertyDescriptor(current(), key);
    // the proxy's own target is empty and extensible, so it may report any key as a configurable one of its own
    return own && { ...own, configurable: true };
  },
  // a property defined on the port lands on the bridge (configurable, like every key the port reports)
  defineProperty: (_target, key, descriptor) => Reflect.defineProperty(current(), key, { ...descriptor, configurable: true }),
  // the port can't be frozen or sealed: it reads a bridge that a later install replaces
  preventExtensions: () => false,
});
