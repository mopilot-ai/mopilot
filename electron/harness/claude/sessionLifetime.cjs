// Claude SDK process identity and graceful retirement: obsolete streams cannot publish into a successor with the same session key.
const { clock } = require('../../platform/ports/clock.cjs');
const { noteIgnored, ignoring } = require('../../ignored.cjs');
const { watchTree, reapTree } = require('../../platform/processTree.cjs');
const winbin = require('../../platform/winbin.cjs');

/**
 * @param {import('./state.cjs').ClaudeState} state
 * @param {{ hold?: typeof winbin.holdWindowsTree, endHeld?: typeof winbin.endHeld, platform?: string }} [o]
 */
function createSessionLifetime(state, { hold = winbin.holdWindowsTree, endHeld = winbin.endHeld, platform = process.platform } = {}) {
  /** End what a Windows CLI's job still holds (winbin.cjs endHeld): its commands, never its pid. */
  const release = (s) => {
    if (s.held) void endHeld(s.held);
    s.held = null;
  };
  const owners = new Map();
  return {
    claim(s) {
      owners.set(s.key, s);
    },
    active(s) {
      return state.sessions.get(s.key) === s;
    },
    requireCurrent(s, value) {
      if (state.sessions.get(s.key) !== s) throw new Error('The Claude process changed before the request completed.');
      return value;
    },
    owns(s) {
      return owners.get(s.key) === s;
    },
    /**
     * The CLI's pid, reported by the SDK: its descendants are recorded while it runs, so a CLI killed outside MoPilot
     * cannot leave its commands behind (#1486). A CLI the SDK starts again is watched afresh. On Windows, where nothing
     * is recorded, a Job Object holds what it starts instead; the job of a CLI the SDK replaced ends then, its CLI gone.
     */
    watch(s, pid) {
      s.tree?.stop();
      s.tree = watchTree(pid);
      if (platform !== 'win32') return;
      release(s);
      s.held = { pid, job: hold(pid) };
    },
    /** Its end is its chat's to hear: send() didn't replace it, it isn't a prewarm no chat took (claudePrewarm.cjs), and it owns its key. */
    speaks(s) {
      return !s.replaced && !state.prewarmed.has(s.key) && owners.get(s.key) === s;
    },
    finish(s) {
      if (owners.get(s.key) === s) owners.delete(s.key);
      // whatever commands it left running (it was killed, or crashed) end with it
      if (s.tree) reapTree(s.tree).catch(ignoring('end the commands a Claude Code process left running'));
      release(s);
    },
    /** End the input first so exit hooks can finish; close the SDK query after its grace period. */
    async retire(key, graceMs = state.timing.retireMs) {
      const s = state.sessions.get(key);
      if (!s) return false;
      state.sessions.delete(key);
      // A replacement or rewind suppresses the stream's close event. Readers of the live CLI still need its invalidation.
      if (s.replaced) state.emit({ key, kind: 'processRetired' });
      clock.clearTimeout(s.retireTimer);
      try {
        s.input.close();
      } catch (error) {
        noteIgnored("close an ending Claude Code session's input", error);
      }
      /** @type {NodeJS.Timeout | undefined} */
      let grace;
      const ended = Promise.race([s.done.then(() => true), new Promise((r) => (grace = clock.setTimeout(r, graceMs, false)))]).then(
        (quit) => {
          // a CLI that exited in time leaves no grace timer behind
          clock.clearTimeout(grace);
          try {
            s.q.close();
          } catch (error) {
            noteIgnored('close a retired Claude Code query', error);
          }
          if (state.retiring.get(key) === ended) state.retiring.delete(key);
          return quit;
        },
      );
      state.retiring.set(key, ended);
      return ended;
    },
  };
}

module.exports = { createSessionLifetime };
