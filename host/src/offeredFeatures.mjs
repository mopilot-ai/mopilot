// The features a Host offers in its hello: the declared ones, less those that need something this Host was built without (a data directory for the chat journal, a source for the `/` menu's commands), so a client never agrees on a feature that would be refused.
import { SIDE_CHAT_FEATURE } from '../../shared/host/sideChats.mjs';

/** Features that need a data directory. */
const NEEDS_DATA_DIR = ['journalLifecycle', 'historyPages', 'chatList', SIDE_CHAT_FEATURE];

/** @param {string[]} features @param {{ dataDir?: string, commands?: unknown }} has */
export const offeredFeatures = (features, { dataDir, commands }) =>
  features.filter((f) => (dataDir || !NEEDS_DATA_DIR.includes(f)) && (commands || f !== 'commands'));
