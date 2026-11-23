// window.native.computer: computer use: access cards, take over and hand back, permissions and grants (electron/capabilities/tools).
const { invoke, on } = require('./spec.cjs');

module.exports = {
  /** answer a card Sage asked for (computerAccess, computerConfirm, browserOrigin); the first answer wins */
  answer: invoke('computer:answer', 2),
  /** after "You took over": let the agent continue */
  resume: invoke('computer:resume', 1),
  stop: invoke('computer:stop', 1),
  /** the control strip: take an app over from the agent working in it in the background, or hand it back */
  takeOver: invoke('computer:takeOver', 2),
  handBack: invoke('computer:handBack', 2),
  /** the "working in" stack: a throttled window thumbnail or opened live view (only with Screen Recording granted), bring it forward */
  workingThumb: invoke('computer:workingThumb', 4),
  bringToFront: invoke('computer:bringToFront', 2),
  /** an app's display name, bundle id and icon, for a bundle id or a name an agent used */
  appIdentity: invoke('computer:appIdentity', 1),
  /** the chat was archived or deleted: drop its desktop grants and let go of the desktop */
  forget: invoke('computer:forget', 1),
  /** the permission guide card's "Check again": true when nothing is missing now */
  recheck: invoke('computer:recheck', 1),
  status: invoke('computer:status'),
  requestPermission: invoke('computer:requestPermission', 1),
  openSettings: invoke('computer:openSettings', 1),
  revoke: invoke('computer:revoke', 2),
  revokeAll: invoke('computer:revokeAll'),
  /** what was approved on a Host's desktop: one app (chatId null: the machine's always-allowed list), or the machine's whole always-allowed list */
  revokeOnMachine: invoke('computer:revokeOnMachine', 3),
  revokeAllOnMachine: invoke('computer:revokeAllOnMachine', 1),
  /** the pane of a Host chat's desktop: watch (paneId, chatId), view (paneId, { visible, takeover }), stop (paneId), input (paneId, input); frames arrive on onDesktopFrame */
  desktopWatch: invoke('desktop:remoteWatch', 3),
  desktopView: invoke('desktop:remoteView', 2),
  desktopStop: invoke('desktop:remoteStop', 1),
  desktopInput: invoke('desktop:remoteInput', 2),
  onDesktopFrame: on('desktop:remoteFrame'),
  setDeny: invoke('computer:setDeny', 1),
  setBriefForeground: invoke('computer:setBriefForeground', 1),
  setCodexNativeComputer: invoke('computer:setCodexNativeComputer', 1),
  onChanged: on('computer:changed'),
  /** Record a skill: start a recording for a chat ('home': the new chat's box), its state, Discard, and the recording's block when it ends */
  recordStart: invoke('computer:recordStart', 1),
  recordState: invoke('computer:recordState'),
  recordDiscard: invoke('computer:recordDiscard'),
  onRecordDone: on('computer:recordDone'),
  onRecordChanged: on('computer:recordChanged'),
};
