// Panel/phone typed input resolves explicit attachment ids, skills and references, retaining main-derived native identity through every adapter and queue.
const { identifyInput } = require('../session/contract/inputGuard.cjs');
/**
 * A message typed by the user in the panel: a turn they started, as one sent from the app's window, on their pick, with
 * the files attached to it, the skills it names that its harness takes besides the text, and the chats it mentions.
 */
const typed = (
  /** @type {{ text: string, model: string | null, effort: string | null, attachments: string[], nativeMessageId?: string, chromePanelTab?: import('../../shared/chromeHandoff.mjs').ChromePanelTarget }} */ p,
  /** @type {InstanceType<typeof import('./chromePanelFiles.cjs').PanelFiles>} */ files,
  /** @type {{ kind: 'skill', name: string, path: string }[]} */ skills,
  /** @type {{ kind: 'session', path: string, name: string, text: string }[]} */ references,
) => {
  /** @type {any} */
  const input = {
    text: p.text,
    attachments: [...files.take(p.attachments), ...skills, ...references],
    opts: {
      human: true,
      ...(p.model ? { model: p.model } : {}),
      ...(p.effort ? { effort: p.effort } : {}),
      ...(p.chromePanelTab ? { chromePanelTab: p.chromePanelTab } : {}),
    },
  };
  if (p.nativeMessageId) {
    input.id = p.nativeMessageId;
    identifyInput(input, p.nativeMessageId);
  }
  return input;
};
module.exports = { typed };
