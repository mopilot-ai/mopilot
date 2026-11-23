// Which windows hold a message not yet sent (a composer draft), as each window reports it: a restart nobody asked for waits for them.
/** webContents ids of the windows whose composer holds unsent text or attachments */
const unsent = new Set();

/**
 * A window's report. Its entry goes when the window does.
 * @param {{ id: number, once: (event: 'destroyed', fn: () => void) => unknown }} sender
 * @param {unknown} has
 */
function report(sender, has) {
  if (has !== true) {
    unsent.delete(sender.id);
    return;
  }
  if (unsent.has(sender.id)) return;
  unsent.add(sender.id);
  sender.once('destroyed', () => unsent.delete(sender.id));
}

/** Some window holds a message not yet sent. */
const anyUnsent = () => unsent.size > 0;

module.exports = { report, anyUnsent };
