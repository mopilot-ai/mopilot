// window.native.momoTrust's types (MoMo's audit log and remembered approvals in Settings, #2290, #2292), merged into NativeApi; the calls are declared in electron/bridge/momoTrust.cjs.

/** The audit log: it checks out (with its entries), it can't go on (why, and whether it can still be exported), or it can't be used now (why). */
export type MomoAuditState =
  | { state: 'ok'; entries: number }
  | { state: 'stuck'; reason: string; exportable: boolean }
  | { state: 'unavailable'; reason: string };
/** The remembered approvals: readable, unreadable (they can be set aside), or not usable now (and why). */
export type MomoApprovalsState = { state: 'ok' } | { state: 'unreadable' } | { state: 'unavailable'; reason: string };
export interface MomoTrustStatus {
  audit: MomoAuditState;
  approvals: MomoApprovalsState;
  /** the sites MoMo may open after reading private data ("Always allow <host>"), sorted; empty while the approvals can't be read */
  sites: string[];
}

declare module '../native' {
  interface NativeApi {
    momoTrust: {
      /** each throws `not_allowed` while MoMo is off, `not_started` before its services are made */
      status(): Promise<MomoTrustStatus>;
      /** the file's name once saved, null when the user cancelled */
      exportAudit(): Promise<{ saved: string | null }>;
      /** throws `not_needed` when the log can go on; resolves the folder the old log was set aside in */
      startOverAudit(): Promise<{ aside: string }>;
      /** throws `not_needed` when the approvals can be read */
      setAsideApprovals(): Promise<{ keptAs: string | null }>;
      /** forgets an always-allowed site; whether it was on the list */
      removeSite(host: string): Promise<{ removed: boolean }>;
    };
  }
}
