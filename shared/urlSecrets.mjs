// Which parts of a web address may carry a credential (a query or fragment parameter, a path parameter, a token value), and the address without them.

/**
 * Words in a parameter's name that mark it as a credential whatever its value, matched as whole words of the name,
 * case-insensitively (and any word starting with `saml`). A parameter dropped by mistake costs a less exact page, a
 * credential kept leaks it.
 */
const SECRET_WORDS = new Set([
  // OAuth, OpenID and WS-Federation
  'nonce',
  'verifier',
  'assertion',
  'wresult',
  // tokens and signatures
  'token',
  'jwt',
  'sig',
  'signature',
  'authkey',
  'apikey',
  'secret',
  'credential',
  'credentials',
  // sessions
  'session',
  'sessionid',
  'sessid',
  'phpsessid',
  'jsessionid',
  'aspsessionid',
  // passwords and one-time codes
  'password',
  'passwd',
  'pwd',
  'passcode',
  'otp',
  'totp',
  'mfa',
  // magic sign-in links
  'magic',
]);
/**
 * Words that name a credential on some sites and plain data on others (?state=CA, ?pin=94107, ?ticket=4521,
 * ?code=SUMMER10, ?key=sort, ?sid=2, ?verify=email). Such a parameter is a credential only when its value looks like
 * one (`credentialLike`), when its address is an OAuth exchange (`oauthExchange`), or when another word of its name
 * qualifies it (api_key, access_code, auth_ticket, reset_pin).
 */
const AMBIGUOUS_WORDS = new Set([
  'state',
  'code',
  'key',
  'pin',
  'pass',
  'ticket',
  'sid',
  'auth',
  'tok',
  'tkn',
  'reset',
  'invite',
  'verify',
  'verification',
  'confirm',
  'confirmation',
  'activation',
]);
/** Endings of a word that mark a credential written as one word (authtoken, clientsecret, xsessionid). */
const SECRET_ENDINGS = ['token', 'secret', 'signature', 'password', 'sessionid', 'sessid', 'apikey', 'authkey'];
/** Words that make an ambiguous word beside them a credential. */
const QUALIFIERS = new Set([
  'api',
  'access',
  'auth',
  'oauth',
  'secret',
  'private',
  'client',
  'session',
  'sign',
  'signing',
  'license',
  'pair',
  'otp',
  'mfa',
  'login',
  'reset',
  'invite',
  'verify',
  'verification',
  'confirm',
  'confirmation',
  'activation',
]);
/** Parameter names (lower case) that alone make an address an OAuth exchange; `code` and `state` together do too. */
const OAUTH_MARKERS = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_verifier'];
/** A JSON Web Token (or an encrypted one) as a value, whatever its parameter is called. */
const JWT = /^eyJ[\w-]*(\.[\w-]*){2,4}$/;
/** A value long and opaque enough to be a token: a bare `t` holding one is a magic link (a short `t` is a time). */
const OPAQUE = /^[\w-]{16,}$/;
/**
 * An unbroken value long enough to be a token (hex, Base64, 4/0AY0e-g7…, s:id.sig), not a path; it must also hold a
 * digit or both letter cases (`credentialLike`), so a long readable value (new-york-city-area) stays.
 */
const DENSE = /^[^\s/]\S{15,}$/;
/** A CAS service, proxy or granting ticket, however short. */
const CAS_TICKET = /^(ST|PT|PGT|TGT)-\d/;
/** Ambiguous words whose value may be a `user:password` pair (a basic-auth or key:secret pair), however short. */
const PAIR_WORDS = new Set(['auth', 'pass', 'key', 'tok', 'tkn', 'sid', 'ticket', 'code']);
/** Text on both sides of a single `:`, no `/` or space (not an address); each side holds a non-digit (not 10:30). */
const PAIR = /^(?=[^:]*\D[^:]*:)[^:/\s]+:(?=[^:]*\D)[^:/\s]+$/;
/** How deep an address inside a parameter's value (next=/cb?token=…) is followed. */
const NESTED = 3;

/** Text as written, decoded where it can be (a value in another encoding stays as it is). */
function decoded(text) {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}

/** A parameter's name as words: snake, kebab and camel case alike, lower case. */
function wordsOf(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Whether a word of a name marks a credential whatever the value. */
function secretWord(w) {
  return SECRET_WORDS.has(w) || w.startsWith('saml') || SECRET_ENDINGS.some((e) => w.endsWith(e));
}

/**
 * Whether a value (decoded) looks like a credential: a CAS ticket, or a long unbroken string with a digit or both
 * letter cases (a JWT is one). `+` decodes to a space, so spaces are read back as `+` (Base64 written raw).
 */
function credentialLike(value) {
  const raw = value.replace(/ /g, '+');
  return CAS_TICKET.test(value) || (DENSE.test(raw) && (/\d/.test(raw) || (/[a-z]/.test(raw) && /[A-Z]/.test(raw))));
}

/** Whether an address's parameter names make it an OAuth exchange: `code` and `state` together, or an OAuth-only name. */
function oauthExchange(names) {
  const lower = new Set(names.map((n) => n.toLowerCase()));
  return (lower.has('code') && lower.has('state')) || OAUTH_MARKERS.some((m) => lower.has(m));
}

/**
 * Whether a parameter's name contains any word that names a credential on some site, whatever its value. Wider than
 * `isSecretParam`, for hiding values where hiding loses nothing (addresses the model reads in listings and logs).
 */
export function mayNameSecret(name) {
  return wordsOf(name).some((w) => secretWord(w) || AMBIGUOUS_WORDS.has(w));
}

/**
 * Whether a parameter (`name`, `value` decoded) may carry a credential: a word in its name that always marks one
 * (access_token, X-Amz-Signature, apiKey, sessionId, oauth_verifier); an ambiguous word (state, code, key, pin,
 * ticket…) that another word qualifies, that holds a credential-like value, or whose address is an OAuth exchange
 * (`oauth`); a token as its value; or an address as its value that carries one (next=/cb?token=…).
 */
export function isSecretParam(name, value = '', oauth = false) {
  return secretParam(name, value, oauth, 0);
}

function secretParam(name, value, oauth, depth) {
  const words = wordsOf(name);
  const v = String(value);
  if (words.some(secretWord)) return true;
  if (
    words.some(
      (w) =>
        AMBIGUOUS_WORDS.has(w) &&
        (oauth || credentialLike(v) || (PAIR_WORDS.has(w) && PAIR.test(v)) || words.some((q) => q !== w && QUALIFIERS.has(q))),
    )
  )
    return true;
  if (JWT.test(v) || (words.join('') === 't' && OPAQUE.test(v))) return true;
  return depth < NESTED && /^(\/|[a-z][\w+.-]*:\/\/)/i.test(v) && secretInUrl(v, depth + 1);
}

/** A `name=value` piece of a query or fragment (as written), its name and value decoded. */
function pieceOf(piece) {
  const eq = piece.indexOf('=');
  return { name: decoded(eq < 0 ? piece : piece.slice(0, eq)), value: eq < 0 ? '' : decoded(piece.slice(eq + 1)) };
}

/** Whether one `name=value` piece of a query or fragment (as written) carries a credential. */
function secretPiece(piece, oauth, depth) {
  const { name, value } = pieceOf(piece);
  return secretParam(name, value, oauth, depth);
}

/** The `name=value` pieces of a fragment (as written), wherever they are in it. */
function fragmentPieces(text) {
  return text.split(/[&;?/]/).filter((piece) => piece.includes('='));
}

/** Whether a query and fragment (as written, without ? and #) make their address an OAuth exchange. */
function oauthIn(search, hash) {
  return oauthExchange([...search.split(/[&;]/), ...fragmentPieces(hash)].map((p) => pieceOf(p).name));
}

/** Whether a fragment (without its #) carries a credential: a bare token, or a credential parameter anywhere in it. */
function secretFragment(text, oauth, depth) {
  return JWT.test(text) || fragmentPieces(text).some((piece) => secretPiece(piece, oauth, depth));
}

/** Whether an address (relative to a page, or absolute) carries a credential in its path parameters, query or fragment. */
function secretInUrl(text, depth) {
  let u;
  try {
    u = new URL(text, 'https://page.invalid/');
  } catch {
    return false;
  }
  const search = u.search.slice(1);
  const hash = u.hash.slice(1);
  const oauth = oauthIn(search, hash);
  return (
    u.pathname !== withoutSecretPathParams(u.pathname, depth) ||
    search.split(/[&;]/).some((piece) => piece && secretPiece(piece, oauth, depth)) ||
    secretFragment(hash, oauth, depth)
  );
}

/** A path without its credential path parameters (/app;jsessionid=…). */
function withoutSecretPathParams(pathname, depth = 0) {
  return pathname.replace(/;([^;/=]*)=([^;/]*)/g, (all, name, value) =>
    secretParam(decoded(name), decoded(value), false, depth) ? '' : all,
  );
}

/**
 * The address without anything that may carry a credential, the rest kept as written (its encoding, order, empty and
 * value-less parameters): each query parameter that may carry one (a `&` part with any `;` piece that does), each such
 * path parameter, and the fragment when it carries one. A URL object is changed in place.
 * @param {URL} u
 */
export function withoutSecrets(u) {
  const path = withoutSecretPathParams(u.pathname);
  if (path !== u.pathname) u.pathname = path;
  const search = u.search.slice(1);
  const hash = u.hash.slice(1);
  const oauth = oauthIn(search, hash);
  const parts = search.split('&');
  const kept = parts.filter((part) => !part.split(';').some((piece) => piece && secretPiece(piece, oauth, 0)));
  if (kept.length !== parts.length) u.search = kept.join('&');
  if (secretFragment(hash, oauth, 0)) u.hash = '';
  return u;
}
