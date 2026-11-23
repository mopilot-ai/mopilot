// Wires MoMo's task marks (momo/taskMarks.cjs) to a sealed file in MoMo's folder: the one place the storage seam gets its disk, its keychain and its clock. Reset MoMo erases the file (momoBackground.cjs, with the routines).
const path = require('node:path');
const { SealedJson } = require('../gateway/sealedFile.cjs');
const { createTaskMarks, marksShape } = require('../momo/taskMarks.cjs');

const FILE = 'task-marks.json';

/**
 * @param {{ dir: string, safeStorage: any, now?: () => number }} o
 * @returns {{ marks: ReturnType<typeof createTaskMarks>, erase: () => Promise<void> }}
 */
function openTaskMarks({ dir, safeStorage, now = Date.now }) {
  const file = new SealedJson({ file: path.join(dir, FILE), safeStorage, now, shape: marksShape });
  return { marks: createTaskMarks({ storage: file, now }), erase: () => file.erase() };
}

module.exports = { openTaskMarks, FILE };
