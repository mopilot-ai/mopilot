// The folder an acceptance run starts its chats in on the machine under test: the one that holds the Host's data folder, never the data folder itself (the Host refuses a chat, a listing or a read in its own data, config and socket folders: host/src/hostFs.mjs `denied`, #5614).
import path from 'node:path';

/** @param {{ dataDir?: string }} state the run's state once the Host is installed (`dataDir` is set by step A3; a run that has none yet names no folder, as before) @returns {string | undefined} */
export const workFolder = (state) => (state.dataDir ? path.posix.dirname(state.dataDir) : undefined);
