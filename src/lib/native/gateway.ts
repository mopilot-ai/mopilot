// window.native.gateway's types (the MCP gateway, electron/gateway, #2999 C2), merged into NativeApi; the calls are declared in electron/bridge/gateway.cjs. A credential goes in and never comes back: a server says only whether one is saved.
export {};

/** How a managed server is signed in to: nothing, a bearer token, a user name and password, a URL parameter, or OAuth. */
export type GatewayAuth = 'none' | 'bearer' | 'basic' | 'urlParam' | 'oauth';

/** A server's connection: not started, starting, ready, failed, needing its credential, or locked (its saved data can't be opened). */
export type GatewayStatus = 'off' | 'starting' | 'ready' | 'failed' | 'needs_credentials' | 'locked';

export type GatewayLaunch =
  | { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { type: 'http'; url: string; headers: Record<string, string> };

/** What the user adds: a stdio server takes no credential (its env is its own). */
export interface GatewayServerSpec {
  name: string;
  launch: GatewayLaunch;
  auth?: GatewayAuth;
}

export type GatewayCredential =
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'urlParam'; param: string; value: string };

export interface GatewayTool {
  /** The server's own name for it. */
  name: string;
  /** The name chats are offered it under. */
  offered: string;
  description: string;
  readOnly: boolean;
  /** Why it is never offered, or null. */
  blocked: string | null;
}

export interface GatewayServer {
  /** The server's identity (a structured key of its launch): the same server keeps it, whatever it is called. */
  key: string;
  name: string;
  transport: 'stdio' | 'http';
  /** Its command or URL. */
  target: string;
  auth: GatewayAuth;
  /** Whether a credential is saved; locked when the vault can't be opened (never read as none). */
  credential: 'saved' | 'none' | 'locked';
  /** An OAuth sign-in is waiting on the browser. */
  signingIn: boolean;
  status: GatewayStatus;
  error: string | null;
  tools: GatewayTool[];
}

export type GatewayView = { state: 'ok'; servers: GatewayServer[] } | { state: 'locked'; reason: string; servers: [] };

/** A rule for gateway tools (shared/toolRules.mjs): a server's key (or `*`), a glob over the tool's own name, a stance, and a scope (`all`, `harness:<id>`, `project:<folder>`). */
export interface GatewayRule {
  id: string;
  connector: string;
  pattern: string;
  stance: 'allow' | 'ask' | 'block';
  scope: string;
  createdAt: number;
}

/** The rules; `unreadable`: their file couldn't be read (every call asks until it is fixed or reset); `invalid`: entries this build couldn't read (kept in the file). */
export interface GatewayRules {
  rules: GatewayRule[];
  state: 'ok' | 'unreadable';
  invalid: number;
}

export type GatewayResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

declare module '../native' {
  interface NativeApi {
    gateway: {
      list(): Promise<GatewayResult<GatewayView>>;
      add(spec: GatewayServerSpec): Promise<GatewayResult<{ key: string }>>;
      remove(key: string): Promise<GatewayResult>;
      connect(key: string, credential: GatewayCredential): Promise<GatewayResult>;
      disconnect(key: string): Promise<GatewayResult>;
      restart(key: string): Promise<GatewayResult>;
      /** OAuth: opens the sign-in page in the browser; resolves when the sign-in ends. */
      signIn(key: string): Promise<GatewayResult>;
      cancelSignIn(key: string): Promise<GatewayResult>;
      rules(): Promise<GatewayResult<GatewayRules>>;
      addRule(rule: Omit<GatewayRule, 'id' | 'createdAt'>): Promise<GatewayResult<{ rule: GatewayRule }>>;
      removeRule(id: string): Promise<GatewayResult>;
      resetRules(): Promise<GatewayResult>;
      onChanged(cb: () => void): () => void;
    };
  }
}
