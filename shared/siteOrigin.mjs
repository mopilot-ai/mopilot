// Browser site input normalization shared by settings and permission writers.
/** A site the user typed, as an origin: http(s) only, a bare host gets https://. Null when it isn't one. */
export function siteOrigin(input) {
  const t = String(input ?? '').trim();
  if (!t) return null;
  try {
    const explicitScheme = /^https?:/i.test(t) || (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(t) && !/^[^/?#@:\s]+:\d+(?:[/?#]|$)/.test(t));
    const u = new URL(explicitScheme ? t : `https://${t}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}
