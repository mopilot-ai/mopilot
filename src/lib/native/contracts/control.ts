// Native bridge capability availability, computer permissions and approval contracts.
import type { CapabilityReasonCode } from '../../../../shared/capabilityReasons.mjs';
import type { SiteBrowser } from './browser';

/** A setup step the status panel offers for a surface (electron/capabilities/nativeAvailability.cjs). */
export type NativeSetupAction =
  | { kind: 'url'; label: string; url: string }
  /** Try again (a failed Codex Computer Use install) or Check again (its permissions) */
  | { kind: 'retry'; label: string }
  | { kind: 'yourChrome'; label: string }
  | { kind: 'settings'; label: string; section: string }
  /** a permission MoPilot's computer-use helper needs: its System Settings pane */
  | { kind: 'computerPermission'; label: string; permission: ComputerPermission }
  /** MoPilot's computer use couldn't start: read its status again (which starts the helper) */
  | { kind: 'computerCheck'; label: string }
  /** MoPilot's own Chrome extension: open its pairing page in the user's Chrome now */
  | { kind: 'chromePair'; label: string }
  | { kind: 'chromeAllow'; label: string }
  | { kind: 'chromeInstall'; label: string };

/** One MoPilot surface as the capability health record has it (electron/capabilities/capabilityHealth.cjs). */
export interface CapabilityHealthSurface {
  state: 'off' | 'unavailable' | 'error' | 'permission' | 'unknown' | 'ready';
  /** sessions are offered its tools */
  usable: boolean;
  reason: string | null;
  /** Presentation code; reason remains diagnostic-only. */
  reasonCode?: CapabilityReasonCode;
  fix: NativeSetupAction | null;
  helperPath?: string | null;
  version?: string | null;
}

/** How one harness reaches Chrome or the computer: the vendor's own path, MoPilot's (as fallback or as its only path), or none. */
export interface NativeSurfaceStatus {
  /** update: MoPilot is updating the vendor runtime (or that failed); permissions: it needs System Settings permissions */
  state: 'native' | 'fallback' | 'mopilot' | 'unavailable' | 'update' | 'permissions' | 'unknown';
  label: string;
  /** why the native path isn't used, when it isn't */
  detail: string | null;
  /** Presentation code; detail remains diagnostic-only. */
  reasonCode?: CapabilityReasonCode;
  actions: NativeSetupAction[];
  /** The route's extension link status is shown live (Claude in Chrome). */
  linkStatus?: boolean;
  /** the vendor runtime's installed version ("Codex Computer Use 26.1005.1001425"), when known */
  version?: string | null;
}

export interface NativeAvailabilityStatus {
  harnesses: { harness: 'codex' | 'claude' | 'acp'; label: string; chrome: NativeSurfaceStatus; computer: NativeSurfaceStatus }[];
  /** MoPilot's own channel serves the user's Chrome to sessions without a Chrome controller of their own (chrome_* tools) */
  chromeTools?: boolean;
  /** MoPilot's own Chrome extension, for every harness it serves; null where main doesn't serve it */
  extension?: NativeSurfaceStatus | null;
  platform: string;
  at: number;
}

/** Levels of a computer-use grant, weakest first (electron/capabilities/contract/policy.cjs). */
export type ComputerLevel = 'view' | 'click' | 'full';

export type ComputerPermission = 'accessibility' | 'screenRecording' | 'inputMonitoring';

export interface ComputerGrant {
  bundleId: string;
  name: string;
  level: ComputerLevel;
  at: number;
}

export interface ComputerStatus {
  /** the remote switch shared.computerUse.enabled */
  enabled: boolean;
  /** path: the helper app this build looks for */
  helper: { running: boolean; version: string | null; error: string | null; path?: string };
  permissions: Record<ComputerPermission, boolean> | null;
  /** the capability health record's verdict on computer use (electron/capabilities/capabilityHealth.cjs) */
  health?: CapabilityHealthSurface | null;
  grants: { global: ComputerGrant[]; chats: { chatId: string; grants: ComputerGrant[] }[] };
  /** what is approved on each Host's desktop, apart from this Mac's lists */
  machines?: { id: string; name: string; global: ComputerGrant[]; chats: { chatId: string; grants: ComputerGrant[] }[] }[];
  deny: { builtIn: { pattern: string; reason: string }[]; user: string[] };
  /** background control may bring an app forward briefly when background input changed nothing (default on) */
  briefForeground: boolean;
  /** Codex chats use Codex Computer Use instead of MoPilot's computer use (Settings, default off) */
  codexNativeComputer?: boolean;
}

/** The params of a card Sage asks for itself (electron/capabilities/contract/approvals.cjs), method sage/KIND. */
export type SageAccessLevel = ComputerLevel | 'read' | 'write';

export interface SageApprovalParams {
  kind:
    | 'computerAccess'
    | 'computerConfirm'
    | 'browserOrigin'
    | 'browserPermission'
    | 'visionConsent'
    | 'computerAccessSet'
    | 'computerTakeover'
    | 'devServer'
    | 'terminalTab'
    | 'momoAction'
    | 'momoConnect'
    | 'sessionStart'
    | 'consent'
    | 'hostAsk'
    | 'gatewayTool'
    | 'remotePair';
  /** Linked-session starts since the last human message; continued starts always ask. */
  count?: number;
  continued?: boolean;
  /** the harness kind of the segment asking: codex, claude, acp:ID */
  harness: string;
  app?: { bundleId: string; name: string };
  origin?: string;
  /** computerAccess or browserOrigin: the level this call needs, and the levels to choose from */
  level?: SageAccessLevel;
  levels?: { id: SageAccessLevel; label: string }[];
  /** browserOrigin: false when the site can't be allowed for good (sign-in details in the address, a remote owner); 'read' when only reading can be (a local server) */
  allowAlways?: boolean | 'read';
  /** browserOrigin and computerConfirm: the site's risk class (electron/capabilities/browser/siteRisk.cjs) */
  risk?: SiteRiskView;
  /** computerConfirm: an ordinary action on a high-risk site, which may be allowed for the rest of the task (no hold) */
  task?: boolean;
  /** computerConfirm: an ordinary action on a high-risk site, whose site's ordinary actions may be allowed for good (#5464) */
  siteAlways?: boolean;
  /** computerConfirm: an ordinary message, which may be allowed on the site for the chat's errand (errandGrants.cjs) */
  errand?: boolean;
  /** computerConfirm: why a message asks every time (it commits the user), shown under the question */
  commits?: string;
  /** browserOrigin and a site's computerConfirm: the page is on this machine (the chat runs there), not on this Mac */
  onMachine?: string;
  /** a card a paired computer raised for this chat (computer access, #1364): the answer goes to that computer */
  remote?: { host: string; hostName: string };
  /** browserOrigin and a site's computerConfirm: the browser it is about (each keeps its own site table) */
  browser?: SiteBrowser;
  /** computerConfirm: what can't be undone */
  verb?: string;
  /** Browser confirmation: the pending action's destination and source page, read by the action gate. */
  actionTarget?: { url: string; page: string; label: string };
  summary?: string;
  tool?: string;
  /** visionConsent: the vision model that will read the screen and the vendor it belongs to */
  model?: string;
  vendor?: string;
  /** computerAccessSet: the apps asked for at their tiers (with a warning for broad-reach apps); computerTakeover: the granted apps */
  apps?: DesktopAccessApp[];
  /** computerAccessSet: apps that are never granted, and why */
  denied?: { name: string; reason: string }[];
  /** computerAccessSet and computerTakeover: the machine the chat's desktop is on, when it is not this Mac */
  machine?: string;
  /** computerAccessSet: what the agent says it will do; computerTakeover: why background control isn't enough */
  reason?: string;
  clipboardRead?: boolean;
  clipboardWrite?: boolean;
  systemKeyCombos?: boolean;
  /** computerAccessSet: the agent will use the real mouse and keyboard in these apps (the screen tools) */
  screenControl?: boolean;
  /** computerAccessSet: a teach tour (desktop_request_teach_access): tooltips the person steps through with Next */
  teach?: boolean;
  /** browserPermission: what a page the user drives in the built-in browser asks to use (its site is `origin`) */
  permissions?: ('camera' | 'microphone' | 'geolocation' | 'notifications')[];
  /** devServer: the command browser_preview_start would run, and the folder it runs in */
  command?: string;
  cwd?: string;
  /** momoAction: what MoMo's trust layer asks about (electron/momo/actionAsk.cjs) */
  momo?: MomoActionParams;
  /** momoConnect: the source a MoMo tool needs connected (electron/momo/sources/connectAsk.cjs) */
  momoConnect?: { source: 'calendar' | 'reminders' };
  /** remotePair: the phone being paired and the six-digit number both screens show (electron/remote/pairApproval.cjs) */
  remotePair?: { deviceName: string; safetyNumber: string };
  /** gatewayTool: the MCP server, its tool and the call's arguments (drawn like hostAsk: its title, details and choices) */
  gateway?: { server: string; tool: string; arguments: string };
  /** hostAsk (and gatewayTool): the question, what it is about, a button per choice; destructive: only a click answers */
  title?: string;
  message?: string;
  details?: string[];
  choices?: { id: string; label: string }[];
  destructive?: boolean;
}

/** A remembered approval's scope on a MoMo card (electron/momo/sentinelRules.cjs SCOPES). */
export type MomoActionScope = 'once' | 'chat' | 'today' | '30d' | 'site';

/** One person or place a MoMo action reaches. */
export interface MomoRecipient {
  kind: 'email' | 'person' | 'channel' | 'app';
  label: string;
}

/** What a momoAction card shows: never the call's arguments, only what the user needs to decide. */
export interface MomoActionParams {
  action: 'read' | 'change';
  tool: string;
  /** the source's name for the user */
  source: string;
  account: string;
  /** the tool's one line on what it will do */
  summary: string;
  hosts: string[];
  recipients: string[];
  /** every recipient with what it is (an address, a channel, a person, an app or page); cut at 20 */
  recipientItems: MomoRecipient[];
  /** how many recipients the action reaches in all, which the cut list never hides */
  recipientCount: number;
  /** why the card can't be allowed: it reaches people and names none, or none that can be read; '' when it can */
  blocked: '' | 'no-recipients' | 'unreadable-recipients';
  /** where it sends data can't be told */
  unknown: boolean;
  /** why it asks even when remembered: 'egress' (a new place after private data), 'carries-data' (an address that may carry it), 'many-opens' (a chat past its no-card opens of listed sites), 'uncertain', 'unknown-destination' */
  reasons: string[];
  /** the scopes this rule allows, once first */
  scopes: MomoActionScope[];
  /** Always deny is offered */
  denyAlways: boolean;
  /** it opens a page (a navigation): the card asks to open the host, and 'site' always allows opening that host */
  opens?: boolean;
}

/** A risky site, as a card shows it. */
export interface SiteRiskView {
  level: 'blocked' | 'high' | 'normal';
  category: string | null;
  label: string;
  explanation: string;
  financial: boolean;
  credentials: boolean;
}

export type DesktopTier = 'read' | 'click' | 'full';

export interface DesktopAccessApp {
  bundleId: string;
  name: string;
  tier: DesktopTier;
  tierLabel?: string;
  warning?: string | null;
  running?: boolean;
}

export interface SageApprovalAnswer {
  decision: 'allow' | 'deny';
  /** task: ordinary site actions until the turn ends; errand: ordinary messages on the site for the chat's errand; today and 30d: a momoAction card's remembered scopes; site: a momoAction open card's Always allow <host>. */
  scope?: 'once' | 'chat' | 'always' | 'task' | 'errand' | 'today' | '30d' | 'site';
  /** momoAction: Always deny */
  always?: boolean;
  level?: SageAccessLevel;
  reason?: string;
  /** computerAccessSet: the bundle ids the user left checked (all when absent), and the extras they allowed */
  apps?: string[];
  clipboardRead?: boolean;
  clipboardWrite?: boolean;
  systemKeyCombos?: boolean;
  /** computerAccessSet: "Always allow": remember the allowed apps at their tiers for every chat (the extras stay this chat's) */
  remember?: boolean;
  /** browserOrigin: "Allow and switch to Auto": the chat switched to Auto, which covers its ordinary sites from now (#1523) */
  then?: 'auto';
  /** hostAsk: the id of the choice clicked */
  choice?: string;
}
