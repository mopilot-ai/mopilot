// window.native.session: each chat's live state and its send queue, owned by main (electron/app/ipc/sessions.cjs, electron/session).
const { invoke, send, on } = require('./spec.cjs');

/* each chat's live state and its send queue, owned by main (electron/session) */
module.exports = {
  snapshot: invoke('session:snapshot', 1),
  answerQuestion: invoke('session:answerQuestion', 3),
  withApprovals: invoke('session:withApprovals'),
  patch: invoke('session:patch', 2),
  pendingModel: invoke('session:pendingModel', 4),
  send: invoke('session:send', 2),
  removeQueued: invoke('session:removeQueued', 2),
  sendNow: invoke('session:sendNow', 2),
  claudeNew: invoke('session:claudeNew', 2),
  claudeOwn: invoke('session:claudeOwn', 2),
  claudeHandover: invoke('session:claudeHandover', 2),
  claudeGoal: invoke('session:claudeGoal', 3),
  claudeStop: invoke('session:claudeStop', 2),
  /** the chat was cleared (/clear): main ends the per-chat processes it can resume later */
  release: invoke('session:release', 1),
  acpNew: invoke('session:acpNew', 2),
  acpCancel: invoke('session:acpCancel', 2),
  caps: invoke('session:caps', 2),
  onCapsChanged: on('session:capsChanged'),
  /** what a new chat on one harness gets once its session opens (its Settings page's "What works in MoPilot") */
  harnessCaps: invoke('session:harnessCaps', 1),
  onPatch: on('session:patch'),
  /** what a Claude Code or ACP turn changed in its folder so far, or in all ({chatId, turnId, diff}) */
  onTurnDiff: on('session:turnDiff'),
  /** what this window's new-chat composer would start on its first send (null: nothing): main warms it (#1664) */
  prewarm: send('session:prewarm', 1),
  /** that send takes it: what main warmed for it, or null */
  prewarmTake: invoke('session:prewarmTake', 1),
  /** this window is open: events about a message it sent come back to it */
  ready: send('session:ready'),
  /** a new chat on a basic harness: the summary the harness the chat is on writes (text, or error) */
  handoffNote: invoke('session:handoffNote', 2),
  /** the switch sheet's lines: the surfaces whose controller a switch to `harness` would change */
  controllerChanges: invoke('session:controllerChanges', 2),
};
