// Drain the relay mailbox once per wake: pushes that land while a drain runs cost exactly one more drain, never a parallel one.
export function createWake(drain: () => Promise<void>) {
  let running: Promise<void> | null = null;
  let again = false;
  async function loop() {
    do {
      again = false;
      try {
        await drain();
      } catch {
        // a failed drain is retried by the next foreground or push
      }
    } while (again);
  }
  return {
    /** A foreground or a push arrived. Resolves when the drain that covers it has finished. */
    wake(): Promise<void> {
      if (running) {
        again = true;
        return running;
      }
      const task = loop().finally(() => {
        if (running === task) running = null;
      });
      running = task;
      return task;
    },
  };
}
