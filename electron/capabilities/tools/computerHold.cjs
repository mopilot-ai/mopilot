// The chat's hold on the desktop after it is taken: letting go, the user's take-over and "Done, continue", and Stop.
const { noteIgnored } = require('../../ignored.cjs');
const { mayAct } = require('../contract/actionGuard.cjs');
const { handedBack, isTakeoverError, stoppedWaiting } = require('./takeoverWait.cjs');
const { helperError } = require('./computerErrors.cjs');

/** @typedef {InstanceType<typeof import('./computer.cjs').ComputerUse>} ComputerUse the control these methods run on */

class ComputerHold {
  /**
   * Lets go of the desktop, e.g. when the chat's turn ends.
   * @this {ComputerUse}
   */
  async release(chatId = this.controlling) {
    if (!chatId || this.controlling !== chatId) return;
    // (through a local: assigned on `this`, the accessor's subclass field would be redeclared here)
    const cu = this;
    cu.controlling = null;
    cu.app = null;
    // input waiting for the user to hand the desktop back goes with the hold
    this.takeover.end(chatId, stoppedWaiting());
    this.onActivity(chatId, null);
    try {
      await this.helper.releaseControl();
    } catch (error) {
      // the helper may have stopped; control is released with it
      noteIgnored('release desktop control in the helper', error);
    }
  }

  /**
   * The helper exited: the hold went with it, and so does input waiting for the user to hand it back.
   * @this {ComputerUse}
   */
  helperExited() {
    const chatId = this.controlling;
    const cu = this;
    cu.controlling = null;
    if (chatId) this.takeover.end(chatId, helperError({ reason: 'helper_stopped' }));
  }

  /**
   * The helper paused input: the user moved the mouse or typed (take-over), or pressed Esc (stop).
   * @this {ComputerUse}
   */
  paused(reason) {
    const chatId = this.controlling;
    if (!chatId) return;
    if (reason === 'escape') return void this.stop(chatId);
    this.takeover.begin(chatId);
    this.onActivity(chatId, { app: this.app, state: 'takeover' });
  }

  /**
   * "Done, continue" after a take-over: input that waited for it goes on.
   * @this {ComputerUse}
   */
  async resume(chatId) {
    if (!chatId || this.controlling !== chatId) return false;
    try {
      await this.helper.resumeControl();
    } catch (error) {
      // still paused: the strip keeps its Resume button
      noteIgnored('resume desktop control after a take-over', error);
      return false;
    }
    this.takeover.end(chatId);
    this.onActivity(chatId, { app: this.app, state: 'active' });
    return true;
  }

  /**
   * The user allowed one of the chat's cards: that answer hands the desktop back for the action they allowed (#1902).
   * @this {ComputerUse}
   */
  async resumeAfterCard(chatId) {
    if (this.takeover.is(chatId)) await this.resume(chatId);
  }

  /**
   * An input the helper refused or cut short because the user moved the mouse or typed: it waits for "Done, continue" and
   * says the user took over, with nothing more done; any other error, or one after Stop, is rethrown as it is (#1905).
   * @this {ComputerUse}
   * @returns {Promise<never>}
   */
  async cutShort(chatId, error, signal) {
    if (!isTakeoverError(error) || !mayAct() || this.controlling !== chatId) throw error;
    // the guard's own "paused" notice may still be on its way
    if (!this.takeover.is(chatId)) this.paused('takeover');
    await this.takeover.wait(chatId, signal);
    throw handedBack('the mouse and keyboard');
  }

  /**
   * Esc or the tray's "Stop controlling your Mac": let go of the desktop and stop the chat's turn.
   * @this {ComputerUse}
   */
  async stop(chatId = this.controlling) {
    if (!chatId) return;
    // the chat's actions stop first (computer_*, then desktop_* and the batches through onStop), so none of them
    // takes the desktop back once it is let go
    this.interrupt(chatId);
    this.onStop(chatId);
    await this.release(chatId);
  }
}

module.exports = { ComputerHold };
