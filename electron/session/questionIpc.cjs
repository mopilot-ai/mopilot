// Trusted renderer ownership for ACP form answers: a chat a main window's pane shows and its live native segment. @host-portable: loads in the Host process without Electron (host/boundary.json).
const { shownBy } = require('./viewing.cjs');
const { windowAnswerer, mayAnswer, REFUSED } = require('../../shared/answerOwner.mjs');

function registerQuestions(ipcMain, { execWindows, viewedBy, live }) {
  ipcMain.handle('session:answerQuestion', (event, chatId, id, answer) => {
    if (
      typeof chatId !== 'string' ||
      typeof id !== 'string' ||
      !execWindows.has(event.sender) ||
      !mayAnswer(
        windowAnswerer((c) => shownBy(viewedBy, event.sender.id, c)),
        chatId,
      )
    )
      return { status: 'denied', error: REFUSED.window };
    const questions = live.acpHost.questions;
    const entry = questions.owner(chatId, id);
    if (!entry) return { status: 'retired' };
    if (!live.controller.isCurrentSource(chatId, { kind: 'acp', key: entry.chat.key })) {
      questions.retire(entry.chat);
      return { status: 'retired' };
    }
    return questions.answer(chatId, id, answer);
  });
}
module.exports = { registerQuestions };
