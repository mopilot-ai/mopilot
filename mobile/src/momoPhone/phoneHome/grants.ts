// Tells every machine the signed-in account may see MoMo, as the Mac does (electron/momo/homeService.cjs keepGranted): at start, every 30 minutes (a grant lapses after 7 days, and a Host that restarted has none) and when a machine's answer changes, once for each machine in that time. A Host that has been told has MoMo to say, so the home is looked at again when one was.

/** How long a machine is not told again. */
export const GRANT_EVERY_MS = 30 * 60_000;
/** A machine that refuses or does not answer is tried again after 30 seconds, then 60, 120 … up to the 30 minutes of a grant: the Mac's own backoff. */
export const GRANT_RETRY_MS = 30_000;

type Machine = { id: string; reachable: boolean };

export function keepGranted(o: {
  machines: () => Machine[];
  grant: (id: string) => Promise<unknown>;
  /** Looks at the Hosts again (a Host that was veiled has MoMo to say now). */
  refresh: () => Promise<unknown>;
  onChange: (fn: () => void) => () => void;
  now: () => number;
  every: (fn: () => void, ms: number) => () => void;
  report?: (error: unknown) => void;
}) {
  const toldAt = new Map<string, number>();
  /** Machines that refused or did not answer: how many times in a row, and when they are tried again. */
  const failed = new Map<string, { fails: number; until: number }>();
  let busy = false;
  let stopped = false;
  const grantAll = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      let any = false;
      await Promise.all(
        o
          .machines()
          .filter((m) => m.reachable)
          .map(async (m) => {
            const at = toldAt.get(m.id);
            if (at !== undefined && o.now() - at < GRANT_EVERY_MS - 60_000) return;
            if ((failed.get(m.id)?.until ?? 0) > o.now()) return;
            try {
              await o.grant(m.id);
              toldAt.set(m.id, o.now());
              failed.delete(m.id);
              any = true;
            } catch (error) {
              const fails = (failed.get(m.id)?.fails ?? 0) + 1;
              failed.set(m.id, { fails, until: o.now() + Math.min(GRANT_EVERY_MS, GRANT_RETRY_MS * 2 ** (fails - 1)) });
              o.report?.(error);
            }
          }),
      );
      if (any && !stopped) await o.refresh();
    } catch (error) {
      o.report?.(error);
    } finally {
      busy = false;
    }
  };
  void grantAll();
  const off = o.onChange(() => void grantAll());
  const stopEvery = o.every(() => void grantAll(), GRANT_EVERY_MS);
  return () => {
    stopped = true;
    stopEvery();
    off();
  };
}
