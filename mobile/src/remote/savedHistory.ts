// The way to clear the chat history this phone keeps (Settings > Privacy): bound while the sealed caches are open, absent when the build keeps none.
let clearer: (() => Promise<unknown>) | null = null;
export const bindSavedHistory = (clear: (() => Promise<unknown>) | null) => void (clearer = clear);
/** Clears the sealed rows and pages, or null when this build keeps no saved history to clear. */
export const savedHistoryClear = () => clearer;
