// Fake Electron Tray and session modules for the electron/main.cjs harness: each tray and partition main makes is kept for tests.
import { mock } from 'node:test';
import { EventEmitter } from 'node:events';

/** A Tray class whose instances land in `trays`, recording the title, tooltip and menu main sets. */
export function fakeTray() {
  const trays: any[] = [];
  class Tray extends EventEmitter {
    image: any;
    title: any = null;
    tooltip: any = null;
    menu: any = null;
    destroyed = false;
    constructor(image: any) {
      super();
      this.image = image;
      trays.push(this);
    }
    setTitle(t: string) {
      this.title = t;
    }
    setToolTip(t: string) {
      this.tooltip = t;
    }
    setContextMenu(m: any) {
      this.menu = m;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  return { Tray, trays };
}

/** Electron's `session`: the default session given, and one partition per name, made on first use and kept in `partitions`. */
export function fakeSession(defaultSession: any) {
  const partitions = new Map<string, any>();
  const resolved = () => mock.fn(async () => undefined);
  const session = {
    defaultSession,
    fromPartition: (name: string) => {
      const clear = { clearStorageData: resolved(), clearCache: resolved(), clearHistory: resolved() };
      if (!partitions.has(name))
        partitions.set(name, Object.assign(new EventEmitter(), { name, ...clear, registerPreloadScript: mock.fn() }));
      return partitions.get(name);
    },
  };
  return { session, partitions };
}
