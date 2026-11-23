// The user's key button in the browser pane: fills a saved login into the page they are looking at. Main finds and focuses the visible username and password fields from an isolated world, types the values with webContents.insertText (as if typed), and checks the page is still on the login's site before each step; the password never reaches the pane, the page's scripts before it is typed, or the model.
const { originOf } = require('./origins.cjs');

/** The isolated world the field finder runs in (the page's own scripts can't reach it). */
const FILL_WORLD = 1207;
// Approved fills share the page's focus and selection; independent requests serialize their write phases.
const fillTails = new WeakMap();
const STATUSES = ['filled', 'no_fields', 'not_found', 'origin_changed', 'cancelled', 'failed'];

/**
 * Script text defining `visible`, `pass` (the visible password field) and `user` (its user-name field) in the page as
 * it is now; the key button's fill and the in-field dropdown (loginAssist.cjs) find the same fields.
 */
const FIELD_FINDER = `
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || 1) > 0.05 && !el.disabled && !el.readOnly;
  };
  const pass = [...document.querySelectorAll('input[type=password]')].find(visible) || null;
  const named = (el) => /user|email|login|account|identifier/i.test([el.autocomplete, el.name, el.id, el.getAttribute('aria-label')].join(' '));
  const texts = [...((pass && pass.form) || document).querySelectorAll('input')].filter((el) => /^(text|email|tel|)$/i.test(el.getAttribute('type') || '') && visible(el));
  // with a password field: the text field just before it in its own form; outside a form, only one named like a
  // user name, so a site's search box never gets the user name
  const before = pass ? texts.filter((el) => el.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING) : texts;
  const user = (pass && pass.form ? before.pop() : before.filter(named).pop()) || null;`;

/**
 * A script for the isolated world: "probe" reports which fields the page shows; "username" or "password" focuses
 * that field and selects what is in it, and says whether it has the focus. Only visible, enabled fields count, so a
 * hidden field can't collect a login.
 */
function fieldScript(step) {
  return `(() => {
  const step = ${JSON.stringify(step)};${FIELD_FINDER}
  if (step === 'probe') return { username: !!user, password: !!pass };
  const el = step === 'password' ? pass : user;
  if (!el) return false;
  el.focus();
  if (el.select) el.select();
  return document.activeElement === el;
})()`;
}

/**
 * Fills saved login `id` into the page of `wc`. Resolves to one of STATUSES; never throws and never puts a value in
 * what it returns.
 * @param {{ wc: any, store: { list(origin: string): { id: string }[], get(id: string, origin: string): { username: string, password: string } | null }, id: string, confirm?: (host: string) => Promise<boolean> }} o
 *   confirm: asks the user to approve (Touch ID) before a password leaves the store; false cancels
 */
async function fillLogin({ wc, store, id, confirm = async () => true }) {
  let retired = false;
  let release;
  let cancel;
  const retirement = new Promise((resolve) => {
    cancel = () => resolve(undefined);
  });
  const retire = () => {
    retired = true;
    cancel();
  };
  const wait = (operation) => Promise.race([operation, retirement]);
  const navigating = (event, _url, _inPlace, mainFrame) => {
    if (event.isMainFrame ?? mainFrame) retire();
  };
  try {
    wc.once('destroyed', retire);
    wc.on('did-start-navigation', navigating);
    const origin = originOf(wc.getURL());
    const current = () => !retired && !wc.isDestroyed() && !wc.isLoadingMainFrame() && originOf(wc.getURL()) === origin;
    if (!current()) return 'origin_changed';
    if (!origin || !store.list(origin).some((l) => l.id === id)) return 'not_found';
    const run = (step) => wc.executeJavaScriptInIsolatedWorld(FILL_WORLD, [{ code: fieldScript(step) }]);
    const found = await wait(run('probe'));
    if (!current()) return 'origin_changed';
    if (!found?.username && !found?.password) return 'no_fields';
    const approved = await wait(confirm(new URL(origin).host));
    if (!current()) return 'origin_changed';
    if (!approved) return 'cancelled';
    // Approval can wait independently; only approved effects reserve a slot, in approval order. Keep this
    // request's original document lifetime while queued. Retired slots settle without bypassing predecessors.
    const previous = fillTails.get(wc) || Promise.resolve();
    const done = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => done);
    fillTails.set(wc, tail);
    void tail.then(() => {
      if (fillTails.get(wc) === tail) fillTails.delete(wc);
    });
    await wait(previous);
    if (!current()) return 'origin_changed';
    const login = store.get(id, origin);
    if (!login) return 'not_found';
    for (const step of /** @type {const} */ (['username', 'password'])) {
      const value = login[step];
      if (!found[step] || !value) continue;
      // the page may have moved to another site while the user approved: nothing is typed there
      if (!current()) return 'origin_changed';
      const focused = await wait(run(step));
      if (!current()) return 'origin_changed';
      if (!focused) return 'failed';
      await wait(wc.insertText(value));
      if (!current()) return 'origin_changed';
    }
  } catch {
    // a page that went away or refused the script: nothing more is typed, and no detail could carry a value
    return 'failed';
  } finally {
    release?.();
    wc.removeListener('destroyed', retire);
    wc.removeListener('did-start-navigation', navigating);
  }
  return 'filled';
}

/**
 * Touch ID before a fill, where the Mac has it; elsewhere the user's click on the key button is the approval.
 * @param {{ canPromptTouchID?: () => boolean, promptTouchID?: (reason: string) => Promise<void> } | null | undefined} systemPreferences
 */
function touchIdConfirm(systemPreferences) {
  return async (host) => {
    if (!systemPreferences?.canPromptTouchID?.()) return true;
    try {
      await /** @type {any} */ (systemPreferences).promptTouchID(`fill your login for ${host}`);
      return true;
    } catch {
      // the user cancelled or Touch ID failed: nothing is filled
      return false;
    }
  };
}

module.exports = { fillLogin, fieldScript, touchIdConfirm, FIELD_FINDER, FILL_WORLD, STATUSES };
