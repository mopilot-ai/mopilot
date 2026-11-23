// Reads Google's downloaded OAuth client file by path (never argv, never logged) into the config the sign-in uses.
/**
 * Google's OAuth endpoints, pinned: a client file names its own `auth_uri` and `token_uri`, but a file is input, and an address taken from input
 * would send the code, the refresh token and the client secret wherever the file says. Only a test passes others.
 */
export const GOOGLE_OAUTH = Object.freeze({
  authUri: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUri: 'https://oauth2.googleapis.com/token',
  revokeUri: 'https://oauth2.googleapis.com/revoke',
});

/** The redirect an iOS OAuth client of this id uses: its id's reverse as a scheme. @param {string} clientId */
export const iosRedirect = (clientId) =>
  `com.googleusercontent.apps.${clientId.replace(/\.apps\.googleusercontent\.com$/, '')}:/oauth2redirect`;

/** The config of an iOS OAuth client the owner made (an id and no secret: PKCE is its proof). @param {string} clientId */
export function iosClientConfig(clientId, oauth = GOOGLE_OAUTH) {
  if (!/^[0-9A-Za-z._-]{10,200}$/.test(clientId)) throw new Error('The iOS client id is not an id');
  return { clientId, clientSecret: '', ...oauth };
}
/** Parses the JSON Google offers (its client id and secret; the endpoints are Google's, pinned) to download for a Desktop client (`{"installed": {...}}`); throws a short text naming no value. */
export function parseClientConfig(text, oauth = GOOGLE_OAUTH) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('The Google client file is not JSON');
  }
  const c = doc?.installed;
  const need = (v, name) => {
    if (typeof v !== 'string' || !v) throw new Error(`The Google client file has no ${name}`);
    return v;
  };
  return {
    clientId: need(c?.client_id, 'client_id'),
    clientSecret: need(c?.client_secret, 'client_secret'),
    ...oauth,
  };
}
/** Loads the client from a file path through the injected reader (the Host's own fs). */
export async function loadClientConfig(path, readFile) {
  return parseClientConfig(await readFile(path));
}
