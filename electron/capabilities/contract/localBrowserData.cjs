// Browser tools backed by this app's local stores, files or processes: unavailable on a remote Host until a Host-owned implementation exists.
const LOCAL_BROWSER_DATA = new Set([
  'browser_history_search',
  'browser_bookmarks_search',
  'browser_request_credentials',
  'browser_file_upload',
]);

/** No tab routing can move these data owners to another machine. @param {unknown} name */
const localBrowserData = (name) => typeof name === 'string' && (LOCAL_BROWSER_DATA.has(name) || name.startsWith('browser_preview_'));
/** A refusal with no cached private content. @param {any} scope @param {any} request */
function localBrowserRefusal(scope, request) {
  return localBrowserData(request.tool) && scope?.lacks(request.chatId, 'localBrowserData')
    ? {
        ...request,
        ok: false,
        content: [],
        error: { code: 'capability_missing', message: 'Browser data on this Mac is unavailable on another Host.' },
      }
    : null;
}

/** Recheck the original result owner as well as the requested name, after a pending call or cache replay settles. */
function protectBrowserResult(scope, request, result) {
  const refused = localBrowserRefusal(scope, { ...request, tool: result.tool });
  if (refused) return { ...refused, tool: request.tool };
  if (result.tool !== request.tool)
    return {
      ...request,
      ok: false,
      content: [],
      error: { code: 'call_id_reused', message: 'This call id already belongs to another tool.' },
    };
  return result;
}
module.exports = { localBrowserData, localBrowserRefusal, protectBrowserResult };
