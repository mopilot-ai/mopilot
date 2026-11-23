// MoMo's cloud accounts as Settings › MoMo › Sources gets them (#2999 C0, electron/momo/connectors/hub.cjs status, electron/momo/connectors/ipc.cjs).

/** An account's access level (the vault's LEVELS): paused, read only, or read and ask to change. */
export type MomoConnectorLevel = 'blocked' | 'read' | 'ask';

/** One connector's row: never a token. `connecting`: its sign-in waits for the browser. */
export type MomoConnector = {
  id: string;
  label: string;
  connected: boolean;
  account: string | null;
  scopes: string[];
  level: MomoConnectorLevel;
  needsReconnect: boolean;
  connecting: boolean;
  tools: { name: string; kind: 'read' | 'change'; description: string }[];
};

/** Why a call failed: MoMo not allowed, a sign-in that was cancelled, timed out or refused, ... */
export type MomoConnectorReason =
  | 'not_allowed'
  | 'unknown'
  | 'not_connected'
  | 'reconnect'
  | 'refused'
  | 'stale'
  | 'failed'
  | 'timeout'
  | 'denied'
  | 'closed'
  | 'token';

export type MomoConnectorsResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; reason?: MomoConnectorReason };
