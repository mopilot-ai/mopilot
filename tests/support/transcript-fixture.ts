// Fixture-local transcript ownership: stop producers and await all writers before removing their directory.
import fs from 'node:fs';

type Transcript = { drain(): Promise<unknown> };

export function transcriptFixture(dir: string) {
  const logs = new Set<Transcript>();
  const stops = new Set<() => void | Promise<void>>();
  let retired = false;
  let pending: Promise<void> | undefined;
  const requireOpen = () => {
    if (retired) throw new Error('Transcript fixture has begun cleanup');
  };
  return {
    own<T extends Transcript>(log: T): T {
      requireOpen();
      logs.add(log);
      return log;
    },
    stopWith(stop: () => void | Promise<void>) {
      requireOpen();
      stops.add(stop);
    },
    cleanup() {
      retired = true;
      pending ??= Promise.resolve()
        .then(async () => {
          const stopped = await Promise.allSettled([...stops].map(async (stop) => stop()));
          const results = await Promise.allSettled([...logs].map(async (log) => log.drain()));
          const errors: unknown[] = [];
          for (const result of [...stopped, ...results]) if (result.status === 'rejected') errors.push(result.reason);
          if (errors.length) throw new AggregateError(errors, 'Could not finish transcript fixture cleanup');
          fs.rmSync(dir, { recursive: true, force: true });
          logs.clear();
          stops.clear();
        })
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
  };
}
