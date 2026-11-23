// The lists a paired phone pages or searches in the open chat (remote methods chat.read with a cursor and mentions.list): older rows and the @ menu's chats and files; what it reads of the chat's work (./phoneSteps.cjs); a chat renamed or archived from a phone (./phoneChatOps.cjs), and a side chat started from one (./phoneSideChat.cjs).
const { createPanelOlder } = require('./chromePanelOlder.cjs');
const { createPanelAt, createPanelStartAt } = require('./chromePanelAt.cjs');
const { createPhoneSteps } = require('./phoneSteps.cjs');
const { createPhoneChatOps } = require('./phoneChatOps.cjs');
const { createPhoneSideChat } = require('./phoneSideChat.cjs');

/**
 * @param {object} d
 * @param {any} d.live main's late-bound services
 * @param {(chatId: string) => boolean} d.reachable whether a chat may be read
 * @param {(chatId: string, record: any) => Promise<{ turns: any[], earlierContentOmitted?: boolean }>} d.historyOf the chat's saved history
 * @param {(limit: number, archived: boolean) => Promise<{ id: string, title: string | null }[]>} d.recent the sidebar's chats, newest first
 * @param {(chatId: string) => Promise<string | null>} d.cwdOf the chat's folder
 * @param {(projectId: string | null) => string | null} d.projectCwd a saved project's folder
 * @param {() => any} d.prefs the app's prefs (the permission a side chat starts on)
 */
function createPhoneLists({ live, reachable, historyOf, recent, cwdOf, projectCwd, prefs }) {
  return {
    older: createPanelOlder({ live, reachable, historyOf }),
    mentionsList: createPanelAt({ recent, cwdOf }),
    mentionsStart: createPanelStartAt({ recent, projectCwd }),
    ...createPhoneSteps({ live }),
    ...createPhoneChatOps({ live }),
    ...createPhoneSideChat({ live, cwdOf, prefs }),
  };
}

module.exports = { createPhoneLists };
