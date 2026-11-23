// Keeping MoMo's chats apart from the coding side on every family this Host runs (M1 H2a): the rule applied to Claude Code, Codex, the switch runner and ACP at boot, and which families it reached (host/src/sessions.mjs).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isolateMomoChats } = require('../../electron/momo/isolation.cjs');

/**
 * @param {object} o the families this Host made and what they run on
 * @param {unknown} o.claudeFamily whether this Host runs Claude Code
 * @param {unknown} o.codexFamily whether this Host runs Codex
 * @param {any} o.codex the Codex adapter's holder, when it does
 * @param {any} o.claude Claude Code's holder, when it does
 * @param {any} o.switcher @param {any} o.acpHost @param {any} o.controller
 */
export function createMomoIsolation({ claudeFamily: claudeRuns, codexFamily: codexRuns, codex, claude, switcher, acpHost, controller }) {
  const claudeFamily = !!claudeRuns;
  const codexFamily = !!codexRuns;
  /** @type {Set<string>} */
  let isolated = new Set();
  return {
    /**
     * Keeps the chats `isMomoChat` names apart from the coding side on every family this Host runs (electron/momo/isolation.cjs); a family this Host does not run has nothing to isolate.
     * @param {(chatId: string) => boolean} isMomoChat @param {string} workspace
     */
    isolate(isMomoChat, workspace) {
      isolateMomoChats(
        { codex: codexFamily ? codex.codex : undefined, switchRunner: switcher, acpHost, controller },
        { setIsolated: (/** @type {(chatId: string) => boolean} */ fn) => claudeFamily && claude.claude.setIsolated(fn) },
        isMomoChat,
        workspace,
      );
      // per family: one this Host does not run was not isolated, and a MoMo chat on it does not start
      isolated = new Set([...(claudeFamily ? ['claude'] : []), ...(codexFamily ? ['codex'] : []), 'acp']);
    },
    /** Whether `isolate` has kept this family's MoMo chats apart: a MoMo chat starts on a family only after. @param {string} family */
    isolated: (family) => isolated.has(family),
  };
}
