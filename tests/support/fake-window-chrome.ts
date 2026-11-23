// Fake Electron page zoom, title bar chrome and inactive/minimized window presentation for main-process tests, and a window's stream batches as it reads them.
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const { streamItems } = createRequire(import.meta.url)('../../electron/bridge/spec.cjs');

/** A web contents' zoom: the level main sets, and the factor it reads back. */
export class ZoomableContents extends EventEmitter {
  zoomLevel = 0;
  getZoomLevel() {
    return this.zoomLevel;
  }
  setZoomLevel(level: number) {
    this.zoomLevel = level;
  }
  getZoomFactor() {
    return 1.2 ** this.zoomLevel;
  }
}

/** A window's title bar buttons: Windows' caption overlay and macOS's window buttons. */
export class TitleBarWindow extends EventEmitter {
  log: string[] = [];
  visible = false;
  minimized = false;
  overlay: any = null;
  buttons: any = null;
  showInactive() {
    this.visible = true;
    this.log.push('showInactive');
  }
  minimize() {
    this.minimized = true;
    this.visible = false;
    this.log.push('minimize');
  }
  setTitleBarOverlay(o: any) {
    if (o.color === 'throw') throw new Error('no overlay');
    // Electron changes only the options given
    this.overlay = { ...this.overlay, ...o };
  }
  setWindowButtonPosition(p: any) {
    this.buttons = p;
  }
}

/** A recorded `stream:batch` send's [channel, event] list, read as the preload reads it: its JSON bytes and what was cloned beside them. */
export const batchOf = (sent: any[]): any[] => streamItems(sent[1], sent[2]) ?? [];
