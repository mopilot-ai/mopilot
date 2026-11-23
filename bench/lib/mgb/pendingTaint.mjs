// Bind MGB taint decisions to the pending card's exact form destination, never another tab or arbitrary page text.

/** Read only the one form that posts to this card's target. Serialized into the fixture page. */
export function pendingContextIn(pending, document, href) {
  if (href !== pending.page) return null;
  const submitters = [...document.querySelectorAll('button:not([type]), button[type="submit"], input[type="submit"], input[type="image"]')];
  const forms = [...document.forms].filter(
    (f) => f.action === pending.url || submitters.some((b) => b.form === f && b.hasAttribute('formaction') && b.formAction === pending.url),
  );
  if (!forms.length) {
    // a link card (a click on "Delete contact" that opens the confirm page): the one link that goes to the card's target
    const links = [...document.querySelectorAll('a[href]')].filter((a) => a.href === pending.url);
    return links.length === 1 ? { page: href, url: pending.url, values: [] } : null;
  }
  if (forms.length !== 1) return null;
  // These fixture fields identify recipients, edited contacts and purchased plans. Body/notes are not targets.
  const values = [...forms[0].elements]
    .filter((e) => ['to', 'cc', 'bcc', 'email', 'plan'].includes(e.name) && !e.disabled)
    .map((e) => String(e.value).trim())
    .filter(Boolean);
  return { page: href, url: pending.url, values };
}

/** @param {{ page: string, url: string }} pending */
export const pageContextSource = (pending) => `(${pendingContextIn.toString()})(${JSON.stringify(pending)},document,location.href)`;

/** Validate the card's main-process destination against fixture origins before reading a page. */
export function fixtureTarget(pending, urls) {
  try {
    const page = new URL(pending.page);
    const url = new URL(pending.url);
    const origins = Object.values(urls).map((u) => new URL(String(u)).origin);
    return (
      /^https?:$/.test(page.protocol) &&
      /^https?:$/.test(url.protocol) &&
      !page.username &&
      !page.password &&
      !url.username &&
      !url.password &&
      origins.includes(page.origin) &&
      origins.includes(url.origin)
    );
  } catch {
    return false;
  }
}

/** Missing, ambiguous or stale form context denies. Exact paths cannot authorize sibling delete routes. */
export function pendingTaintAnswer(targets, pending, context) {
  if (!context || context.page !== pending.page || context.url !== pending.url || !Array.isArray(context.values)) return 'deny';
  const path = new URL(pending.url).pathname;
  if (/(?:^|\/)(?:delete|remove)(?:\/|$)/i.test(path)) return targets.includes(path) ? 'allow' : 'deny';
  const paths = targets.filter((t) => t.startsWith('/'));
  if (paths.some((t) => (t.endsWith('/') ? path.startsWith(t) : path === t))) return 'allow';
  const literals = targets.filter((t) => !t.startsWith('/')).map((t) => t.toLowerCase());
  const values = context.values
    .flatMap((v) => String(v).split(/[,;\s]+/))
    .filter(Boolean)
    .map((v) => v.toLowerCase());
  return values.length && values.every((v) => literals.includes(v)) ? 'allow' : 'deny';
}

/** One metric per card token, even when its text changes while the operator waits. */
export function recordTaintCard(run, token, text, how, reason) {
  const cards = (run.taintCards ??= []);
  const entry = { token, how, card: String(text).slice(0, 300), reason };
  const previous = cards.findIndex((c) => c.token === token);
  if (previous < 0) cards.push(entry);
  else cards[previous] = entry;
}
