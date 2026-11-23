// An image a reply names (`![alt](url)`) as the side panel draws it: a data: raster inline, an https: one only after a click, anything else stays the text it is.
//
// The reply is the agent's and may quote a page, so a remote image's address can carry what the page held; drawing one
// would send it to that server unasked (the extension page has no img-src limit). So an https: image waits behind a
// button that names its host, and a click draws it (the address is remembered, so a re-render keeps it drawn). A data:
// image holds its own bytes and loads nothing. Never svg (not a raster), never http:.

/** A data: URL of a raster image. */
const DATA = /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i;
/** The https: addresses the user asked to see. */
const shown = new Set();

/** Whether an image address may be drawn at all (now or after a click). */
export const imageAllowed = (/** @type {string} */ url) => DATA.test(url) || (/^https:\/\//i.test(url) && URL.canParse(url));

/** The image element itself: text alt, no referrer, never wider than the panel (css). */
function picture(/** @type {any} */ doc, /** @type {string} */ alt, /** @type {string} */ url) {
  const img = doc.createElement('img');
  img.setAttribute('src', url);
  img.setAttribute('alt', alt);
  img.setAttribute('referrerpolicy', 'no-referrer');
  return img;
}

/**
 * The node for one image: the picture for a data: image or one the user asked for, else the button that asks.
 * @param {any} doc @param {string} alt the reply's alt text (may be empty) @param {string} url an address imageAllowed took
 */
export function imageNode(doc, alt, url) {
  const label = alt || 'Image';
  if (DATA.test(url) || shown.has(url)) return picture(doc, label, url);
  const box = doc.createElement('span');
  box.className = 'img-box';
  const ask = doc.createElement('button');
  ask.type = 'button';
  ask.className = 'img-load';
  ask.textContent = `Show image: ${label}`;
  ask.title = `Loads from ${new URL(url).host}`;
  ask.addEventListener('click', () => {
    shown.add(url);
    box.replaceChildren(picture(doc, label, url));
  });
  box.append(ask);
  return box;
}
