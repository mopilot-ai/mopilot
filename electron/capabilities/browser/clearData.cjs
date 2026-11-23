// "Clear browsing data" for the in-app browser. History is not stored separately: it is each open
// tab's back/forward list, so clearing it means clearing the navigation history of every page that
// lives in the browser's session, alongside the session's cookies, storage and cache.

/**
 * @param {{ clearStorageData(): Promise<void>, clearCache(): Promise<void> }} ses the in-app browser's session
 * @param {import('electron').WebContents[]} pages every live WebContents (only the session's are touched)
 */
async function clearBrowsingData(ses, pages) {
  await ses.clearStorageData();
  await ses.clearCache();
  for (const wc of pages) if (wc.session === ses && !wc.isDestroyed()) wc.navigationHistory.clear();
}

module.exports = { clearBrowsingData };
