// window.native.routes's types (each harness's route as its own config sets it), merged into NativeApi; the calls are declared in electron/bridge/routes.cjs.

/** A harness's route (shared/route.mjs) with what main knows of its processes (electron/harness/routes.cjs). */
export interface HarnessRouteEntry {
  /** 'codex', 'claude', 'acp:<id>' */
  harness: string;
  /** mopilot-routed: MoPilot's model router sends it to the user's own provider (shared/route.mjs withRouted) */
  kind: 'direct' | 'external' | 'unknown' | 'mopilot-routed';
  router: { id: string; label: string } | null;
  /** short name of where requests go: the router, a cloud, 'local gateway' or the endpoint's host */
  label: string | null;
  /** the endpoint's origin, never its path or query */
  endpoint: string | null;
  loopback: boolean;
  model: string | null;
  provider: string | null;
  cloud: string | null;
  catalog: string | null;
  reasons: ('endpoint' | 'model' | 'cloud' | 'router')[];
  sources: { file: string | null; key: string }[];
  /** the file that sets it, for Show config file */
  file: string | null;
  /** why a file couldn't be read (kind 'unknown') */
  error: string | null;
  signature: string;
  changedAt: number;
  /** the last route that could be read, while a file can't be */
  lastGood: Omit<HarnessRouteEntry, 'harness' | 'changedAt' | 'lastGood' | 'stale' | 'effects'> | null;
  /** processes that started before the route changed: still working, and idle (Restart to apply restarts these) */
  stale: { running: number; idle: number };
  /** what the route turned off in MoPilot itself; routedOff: the harness's config wins over Your own provider */
  effects: ('poolingOff' | 'routedOff')[];
}

declare module '../native' {
  interface NativeApi {
    routes: {
      list(): Promise<HarnessRouteEntry[]>;
      /** read every harness's files again (a window came to the front) */
      refresh(): Promise<HarnessRouteEntry[]>;
      onChanged(cb: (list: HarnessRouteEntry[]) => void): () => void;
      /** shows the file that sets the harness's route in Finder; false when none does */
      reveal(harness: string): Promise<boolean>;
      /** restarts the harness's idle processes that started before its route changed */
      restartIdle(harness: string): Promise<{ restarted: number; busy: number }>;
    };
  }
}
