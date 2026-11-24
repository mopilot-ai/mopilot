// Which local files and addresses a browser command may name (R2b of #5576): a page is handed a local file only through the folders this Host shares and never one of its own, and is made to fetch a web address only. `DOM.setFileInputFiles` and a drag's files take paths (resolved by `hostFs`: the roots and the refused folders, by real path); `Network.loadNetworkResource` and a `Fetch` url override take an address, judged by its PARSED protocol (the URL parser drops tabs and newlines and leading control characters, so `file\n:///x` is `file:`; a pattern over the text is not the check). Nothing of a refused path or address is told.
import { BrowserHostError } from './browserHost.mjs';

/**
 * The local file paths a command names: what a page is given to read as an upload.
 * @param {string} method @param {any} params @returns {unknown[]}
 */
export function localPathsOf(method, params) {
  if (method === 'DOM.setFileInputFiles')
    return Array.isArray(params?.files) ? params.files : params?.files === undefined ? [] : [params.files];
  if (method === 'Input.dispatchDragEvent')
    return Array.isArray(params?.data?.files) ? params.data.files : params?.data?.files === undefined ? [] : [params.data.files];
  return [];
}

/** The commands that make the browser fetch an address, and where it is: the resource to load, and the address a paused request is sent to or answered from instead. */
const FETCHED = {
  'Network.loadNetworkResource': (/** @type {any} */ p) => [p?.url],
  'Fetch.continueRequest': (/** @type {any} */ p) => (p?.url === undefined ? [] : [p.url]),
  'Fetch.fulfillRequest': (/** @type {any} */ p) => (p?.url === undefined ? [] : [p.url]),
};

/** Whether a value is a web address by its parsed protocol: http or https, and nothing the parser reads as another scheme (`file:`, `data:`, `blob:`, `javascript:`, `chrome:`). @param {unknown} value */
export function isWebAddress(value) {
  if (typeof value !== 'string') return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Whether a command fetches an address that is not a web one. @param {string} method @param {any} params */
export const fetchesNonWeb = (method, params) =>
  Object.hasOwn(FETCHED, method) && FETCHED[/** @type {keyof typeof FETCHED} */ (method)](params).some((u) => !isWebAddress(u));

/**
 * Why a command may not run, or null: an address that is not a web one, or a local file the Host's folders do not resolve (with no folders to ask, none).
 * @param {string} method @param {any} params @param {{ resolve: (p: unknown) => Promise<string> } | undefined} hostFs @returns {Promise<{ code: 'refused' | 'invalid', message: string } | null>}
 */
export async function localFileProblem(method, params, hostFs) {
  if (fetchesNonWeb(method, params)) return { code: 'refused', message: 'A tab may fetch a web address only (http or https).' };
  for (const file of localPathsOf(method, params)) {
    if (typeof file !== 'string') return { code: 'invalid', message: 'The command is malformed.' };
    try {
      if (!hostFs) throw new Error('no folders');
      await hostFs.resolve(file);
    } catch {
      return { code: 'refused', message: 'That file is not one this host shares.' };
    }
  }
  return null;
}

/**
 * The browser service with that rule in front of its `command`, so no tab command reaches the browser unchecked.
 * @template {{ command: (chatId: string, req: any) => Promise<unknown> }} S
 * @param {S} service @param {{ resolve: (p: unknown) => Promise<string> } | undefined} hostFs @returns {S}
 */
export function withLocalFileGate(service, hostFs) {
  return {
    ...service,
    async command(chatId, req) {
      const problem = await localFileProblem(req?.method, req?.params, hostFs);
      if (problem) throw new BrowserHostError(problem.code, problem.message);
      return service.command(chatId, req);
    },
  };
}
