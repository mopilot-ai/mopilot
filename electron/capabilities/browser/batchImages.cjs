// A batch's images (#3810): a screenshot taken before a later action that changes the page is stale by the time the batch answers, and in Codex's exec a script that prints the whole result (text(r)) puts its base64 into the model's context for every later step (about 17k tokens for 37 steps in one recorded run). Such an image becomes one text line; the last view of the page stays an image.

/** Tool names (without the browser_ or chrome_ prefix) that change the page whatever their input. */
const CHANGES = new Set([
  'navigate',
  'form_input',
  'file_upload',
  'upload_image',
  'resize_window',
  'handle_dialog',
  'javascript_tool',
  'javascript_exec',
]);
/** The `computer` actions that change the page. */
const CHANGING_ACTIONS = new Set(['left_click', 'right_click', 'double_click', 'triple_click', 'type', 'key', 'scroll', 'left_click_drag']);

/**
 * Whether running tool `name` with `input` can change what an earlier screenshot shows.
 * @param {string} name @param {any} input
 */
function changesPage(name, input) {
  const bare = String(name).replace(/^(browser|chrome)_/, '');
  if (bare === 'computer') return CHANGING_ACTIONS.has(String(input?.action));
  return CHANGES.has(bare);
}

/**
 * Replaces every image block in `content` by one text line, in place.
 * @param {{ type: string, [k: string]: any }[]} content
 */
function staleImages(content) {
  content.forEach((c, i) => {
    if (c?.type === 'image') content[i] = { type: 'text', text: '[screenshot not kept: a later action in this batch changed the page]' };
  });
}

/**
 * Awaits a batch action; when it changes the page, the images the batch holds so far are stale.
 * @param {{ type: string }[]} content @param {string} name @param {any} input @param {Promise<any>} running
 */
async function staleAfter(content, name, input, running) {
  const out = await running;
  if (changesPage(name, input)) staleImages(content);
  return out;
}

module.exports = { changesPage, staleImages, staleAfter };
