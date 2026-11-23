// The two mirrors a service offers a paired phone, the terminal and the frames, with the lifecycle they share: a device that leaves ends both.
const { PtyMirror } = require('./mirrorPty.cjs');
const { FrameMirror } = require('./mirrorFrames.cjs');
const { enabled } = require('./mirrorGuard.cjs');

class Mirrors {
  /** @param {any} svc the RemoteService */
  constructor(svc) {
    this.svc = svc;
    this.pty = new PtyMirror(svc);
    this.frames = new FrameMirror(svc);
  }

  /** Whether this device can mirror now: the Mac wired the seams and turned mirrors on for it (always false for the panel). */
  available(/** @type {any} */ client) {
    return client.kind === 'phone' && !!this.svc.ops.mirror && enabled(this.svc, client);
  }

  dropPair(/** @type {string} */ pairId) {
    this.pty.dropPair(pairId);
    this.frames.dropPair(pairId);
  }

  /** Something a running mirror depends on changed (the device's switch, a chat followed or not): end what is no longer allowed. */
  recheck() {
    this.pty.recheck();
    this.frames.recheck();
  }

  closeAll() {
    this.pty.closeAll();
    this.frames.closeAll();
  }
}

module.exports = { Mirrors };
