// Types for shared elicitation approval mappings.
export type ElicitationAction = 'accept' | 'decline' | 'cancel';
/** The response body: content only for an accepted form; no client metadata. */
export declare function elicitationAnswer(
  action: ElicitationAction,
  content: unknown,
  mode: string | undefined,
): {
  action: ElicitationAction;
  content: unknown;
  _meta: null;
};
/** An mcpServer/elicitation/request's params (any Codex mode, or Claude's), as the approval cards hold them. */
export type ElicitationParams = {
  mode?: unknown;
  requestedSchema?: unknown;
  _meta?: unknown;
} & Record<string, unknown>;
export interface NativeAppApproval {
  /** the app Codex's computer use asks to control (its bundle id); null for a request about no app (audio) */
  app: string | null;
  /** the plugin tool that asks (start_audio_recording, …), or null */
  tool: string | null;
  /** the request's own message, verbatim; MoPilot's wording only when it sent none */
  title: string;
  /** who asks, as the request names it (connector_name) */
  connector: string | null;
  /** the request's warning about the app (`subtitle`, or `warningSubtitle`), verbatim */
  warning: string | null;
  /** the risk level the request rates the action (riskLevel), as sent; null for none or "low" */
  risk: string | null;
  /** what the request is about, as it displays it (tool_params_display) */
  details: {
    label: string;
    value: string;
  }[];
  /** the grants the card offers, in its order: an app approval's as Codex App shows them, any other request's narrowest first */
  scopes: {
    value: 'once' | 'session' | 'always';
    label: string;
  }[];
  /** the grant the card leads with (its primary button) */
  lead: 'once' | 'session';
  /** grants the request offers that this version can't give, as sent */
  unsupported: string[];
}
/**
 * Codex's own computer use (the unified-computer-use plugin, on OpenAI's Sky service) asks before it
 * controls an app, or records computer audio, with an empty form whose metadata names the app or tool,
 * the persistence it offers, its risk level and its warning. Null for any other request. The request's
 * own text is kept as sent, so the card reads as Codex App's does.
 */
export declare function nativeAppApproval(p: ElicitationParams | null | undefined): NativeAppApproval | null;
/**
 * The answer to a native app approval: accept with the chosen grant in `_meta.persist` (none for
 * once), or decline / cancel. A scope the request did not offer is answered as cancel.
 */
export declare function nativeAppAnswer(
  p: ElicitationParams | null | undefined,
  choice: string,
):
  | {
      action: ElicitationAction;
      content: unknown;
      _meta: null;
    }
  | {
      action: 'accept';
      content: {};
      _meta: {
        persist: string;
      } | null;
    };
export type BrowserUseKind = 'origin' | 'devtools' | 'history' | 'upload' | 'download' | 'assets' | 'webmcp' | 'action';
/** A grant the card offers. `chat` is a plain accept, which the plugin keeps for the chat by itself. */
export type BrowserUseChoice = 'once' | 'chat' | 'session' | 'site' | 'always' | 'allSites';
export interface BrowserUseApproval {
  kind: BrowserUseKind;
  /** the site as the plugin names it (scheme, host and port), or null */
  origin: string | null;
  /** the site's host, shown first; null when the origin is not a URL */
  host: string | null;
  /** the browser the plugin drives ("Chrome", "Browser") */
  browser: string | null;
  /** the request's own reason or subtitle */
  reason: string | null;
  /** what the action is about, in order */
  details: {
    label: string;
    value: string;
  }[];
  /** the plugin marks the action sensitive (codex_sensitive_action) */
  sensitive: boolean;
  /** the plugin rates the action high risk (riskLevel, full DevTools access) */
  highRisk: boolean;
  /** the allow choices the request offers, narrowest first */
  choices: {
    value: BrowserUseChoice;
    label: string;
  }[];
}
/** The host of an origin, or null for anything that is not a URL. */
export declare function originHost(origin: string | null): string | null;
/** A Browser plugin approval, typed; null for any other request (a form with fields stays a form). */
export declare function browserUseApproval(p: ElicitationParams | null | undefined): BrowserUseApproval | null;
/**
 * The answer to a Browser plugin approval: accept with the grant's `_meta`, or decline / cancel. A
 * grant the request did not offer is answered as cancel.
 */
export declare function browserUseAnswer(
  p: ElicitationParams | null | undefined,
  choice: string,
):
  | {
      action: ElicitationAction;
      content: unknown;
      _meta: null;
    }
  | {
      action: 'accept';
      content: {};
      _meta: Record<string, string> | null;
    };
/**
 * Whether "Allow for all sites" can take effect: Codex's requirements (configRequirements/read) must
 * not turn off global approval for browser use. No answer counts as no: the plugin would keep such a
 * grant for this chat only.
 */
export declare function allowsAllSites(read: unknown): boolean;
