// The blocked page (blocked.html, #1986), as Claude in Chrome's: the address the administrator blocks, as text, and Go back; the site itself never loads.

/** The address the page was opened for (`#url=`), as text; empty for anything that isn't a web address. */
export function blockedUrl(/** @type {string} */ hash) {
  const url = new URLSearchParams(String(hash).replace(/^#/, '')).get('url') ?? '';
  return /^https?:\/\//i.test(url) ? url.slice(0, 2_000) : '';
}

/** Shows the page in its window (`g`: document, location, history). */
export function showBlocked(/** @type {any} */ g) {
  const { document, location, history } = g;
  document.getElementById('blocked-url').textContent = blockedUrl(location.hash);
  document.getElementById('back').addEventListener('click', () => history.back());
}
