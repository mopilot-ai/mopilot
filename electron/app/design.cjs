// Design systems kept as files in the project: the app's DesignService (electron/design/service.cjs) over the user's
// library in ~/.mopilot/design-systems, and the design_* tools it serves on every harness's tool channel.
const path = require('node:path');
const os = require('node:os');
const { DesignService } = require('../design/service.cjs');
const { registerDesignTools } = require('../capabilities/tools/designTools.cjs');
const { chatAnchorOf } = require('../capabilities/anchor.cjs');

/**
 * Registers the design tools on `live.capabilities` and returns the service (live.design).
 * @param {object} o
 * @param {any} o.live main's late-bound services (capabilities, sessions, controller)
 * @param {(ctx: any) => string | null} o.owner the chat a call came from
 * @param {(chatId: string) => Promise<string | null>} o.chatProject the chat's folder
 * @param {() => any} o.uiPrefs the app's prefs (the default permission a chat starts in)
 * @param {(key: string) => boolean} o.isFlagEnabled
 * @param {string} [o.home]
 */
function registerDesign({ live, owner, chatProject, uiPrefs, isFlagEnabled, home = os.homedir() }) {
  const design = new DesignService({ userDir: path.join(home, '.mopilot', 'design-systems') });
  registerDesignTools(live.capabilities, {
    design,
    owner,
    projectOf: chatProject,
    anchor: ({ chatId }) => chatAnchorOf(chatId, { sessions: live.sessions, controller: live.controller, prefs: uiPrefs }),
    enabled: () => isFlagEnabled('shared.design.enabled'),
  });
  return design;
}

module.exports = { registerDesign };
