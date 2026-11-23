// Installing a missing agent on a remote machine, as main reports it (electron/host/machineInstall.cjs): the latest view of each install, one subscription shared by every window part that shows them, followed only while Host exists for the account.
import { useEffect, useSyncExternalStore } from 'react';
import { installLine } from '../../shared/host/installWords.mjs';
import { native } from './native';
import type { HostInstallView } from './native/host';
import { useHostAccess } from './host';

export type { HostInstallView };

const STATES = new Set<string>(['queued', 'running', 'installed', 'failed', 'cancelled', 'unreachable']);
/** An install that is still going: its button turns into Cancel and its line shows. */
export const INSTALLING = new Set<HostInstallView['state']>(['queued', 'running']);

/** The key of one install: a machine and the agent on it. */
export const installKey = (hostId: string, harness: string) => `${hostId}\n${harness}`;

export { installLine };

const NONE: ReadonlyMap<string, HostInstallView> = new Map();

let views = NONE;
let refs = 0;
let stop: (() => void) | null = null;
const listeners = new Set<() => void>();

const publish = (next: ReadonlyMap<string, HostInstallView>) => {
  views = next;
  for (const l of listeners) l();
};

const text = (v: unknown) => (typeof v === 'string' ? v : null);

/** What main sent as an install view, or null when it is not one (nothing half-read is drawn). */
export function parseInstallView(v: unknown): HostInstallView | null {
  const o = v as Partial<HostInstallView> | null;
  if (!o || typeof o.hostId !== 'string' || !o.hostId || typeof o.harness !== 'string' || !o.harness) return null;
  if (typeof o.state !== 'string' || !STATES.has(o.state)) return null;
  return { hostId: o.hostId, harness: o.harness, state: o.state, line: text(o.line) ?? '', error: text(o.error), version: text(o.version) };
}

const remember = (view: HostInstallView | null) => {
  if (view) publish(new Map(views).set(installKey(view.hostId, view.harness), view));
};

function acquire() {
  if (refs++ === 0) stop = native.host.onAgentInstall((next) => remember(parseInstallView(next)));
  return () => {
    if (--refs === 0) {
      stop?.();
      stop = null;
      publish(NONE);
    }
  };
}

/** Install `harness` on the machine (a second start joins the one under way); rejects with the reason when main refuses. */
export async function startInstall(hostId: string, harness: string): Promise<void> {
  remember(parseInstallView(await native.host.installAgent(hostId, harness)));
}

/**
 * Install `harness` on the machine and settle when that install ends: resolves once it is installed or cancelled (or no longer followed),
 * rejects with the machine's reason when it failed. For a caller that shows its own busy state (a Settings row); the store must be followed (useHostInstalls).
 */
export function installAndWait(hostId: string, harness: string): Promise<void> {
  const key = installKey(hostId, harness);
  return new Promise<void>((resolve, reject) => {
    let started = false;
    const check = () => {
      const view = views.get(key);
      // a view from an earlier install is not this one's end: only what came after this start counts
      if (!started || (view && INSTALLING.has(view.state))) return;
      listeners.delete(check);
      if (view && (view.state === 'failed' || view.state === 'unreachable')) reject(new Error(installLine(view)));
      else resolve();
    };
    listeners.add(check);
    startInstall(hostId, harness).then(
      () => {
        started = true;
        check();
      },
      (e) => {
        listeners.delete(check);
        reject(e);
      },
    );
  });
}

/** Stop the install; the machine's answer arrives through the same subscription. */
export async function cancelInstall(hostId: string, harness: string): Promise<void> {
  await native.host.cancelInstallAgent(hostId, harness);
}

/** How each install stands, by `installKey`; empty while Host is not available. The first call to need them starts following main. */
export function useHostInstalls(): ReadonlyMap<string, HostInstallView> {
  const allowed = useHostAccess();
  useEffect(() => (allowed ? acquire() : undefined), [allowed]);
  const current = useSyncExternalStore(
    (cb) => (listeners.add(cb), () => void listeners.delete(cb)),
    () => views,
  );
  return allowed ? current : NONE;
}
