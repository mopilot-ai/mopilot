// The forms a pane page posted, by page and address: what the page notice's Resubmit sends again. Chromium drops a form result's data once Back or a reload can't show it from the cache (ERR_CACHE_MISS), so a reload then posts nothing; the data is kept here as the page sent it.
//
// Only top-level navigations are watched (the filter's `types`), so the pages' own requests pay nothing. A form with a
// file or a blob in it is not kept: it can't be sent again as it was; nor is one over MAX_BYTES, which a page's history
// would otherwise hold in main for as long as the page lives.

/** Sessions watched already. */
const installed = new WeakSet();
/** @type {Map<number, Map<string, { postData: { type: 'rawData', bytes: Buffer }[], contentType: string }>>} */
const posts = new Map();
/** Forms kept per page: the latest ones, which Back can reach. */
const KEEP = 8;
/** The largest form body kept (a search or an application form is far smaller). */
const MAX_BYTES = 256 * 1024;

/** The body's own type: a multipart body names its boundary on its first line, anything else is a URL-encoded form. */
function contentTypeOf(/** @type {Buffer} */ bytes) {
  const head = bytes.subarray(0, 200).toString('latin1');
  const m = /^--([^\r\n]+)\r\nContent-Disposition: form-data/i.exec(head);
  return m ? `multipart/form-data; boundary=${m[1]}` : 'application/x-www-form-urlencoded';
}

/**
 * Keeps the form a page posted. A request that carries no data (Back trying the cache) keeps the one before.
 * @param {{ method?: string, url: string, webContentsId?: number, uploadData?: { bytes?: Buffer, file?: string }[] }} d
 * @param {(id: number) => any} fromId
 */
function record(d, fromId) {
  const id = d.webContentsId;
  if (d.method !== 'POST' || !id || !d.uploadData?.length) return;
  let page = posts.get(id);
  if (!page) {
    const wc = fromId(id);
    if (!wc) return;
    page = new Map();
    posts.set(id, page);
    wc.once('destroyed', () => posts.delete(id));
  }
  page.delete(d.url);
  if (!d.uploadData.every((u) => u.bytes)) return;
  const parts = /** @type {Buffer[]} */ (d.uploadData.map((u) => u.bytes));
  if (parts.reduce((n, b) => n + b.length, 0) > MAX_BYTES) return;
  const postData = parts.map((bytes) => ({
    type: /** @type {'rawData'} */ ('rawData'),
    bytes: Buffer.from(bytes),
  }));
  page.set(d.url, { postData, contentType: contentTypeOf(postData[0].bytes) });
  if (page.size > KEEP) page.delete(/** @type {string} */ (page.keys().next().value));
}

/** Watches a pane session's top-level form posts; `pages` finds a page by id (Electron's webContents). */
function installFormPosts(/** @type {any} */ ses, /** @type {{ fromId: (id: number) => any }} */ pages) {
  if (!ses?.webRequest || installed.has(ses)) return;
  installed.add(ses);
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'], types: ['mainFrame'] }, (d, done) => {
    record(d, (id) => pages.fromId(id));
    done({});
  });
}

/** The form page `id` last posted to `url`, or null when it has none it can send again. */
const formPost = (/** @type {number} */ id, /** @type {string} */ url) => posts.get(id)?.get(url) ?? null;

module.exports = { installFormPosts, formPost, record, contentTypeOf, KEEP, MAX_BYTES };
