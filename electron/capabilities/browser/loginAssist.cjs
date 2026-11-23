// Saved logins in the page itself, for the user's browser tabs: a dropdown of the site's saved user names under its sign-in fields (picking one fills it as the key button does), and "Save password?" after the user signs in with a password MoPilot doesn't have.
//
// - A script in the fill world (an isolated world the page's own scripts can't reach) draws the dropdown in a closed
//   shadow root and reports only trusted (user) clicks and keys, as console signals carrying a per-page nonce.
// - On a sign-in (a trusted submit, a click on a button or Enter while the password field has a value) the script
//   keeps the user name and password in its own world and signals; main then takes them from that world, so the
//   password never appears in a console message, the pane or the model. It offers saving them only once the
//   sign-in looks accepted: the page navigates, or a moment later its password field is gone. A refused password
//   (the form still there) is never offered, so it can't replace a saved one.
// - The offer stays in main until the user answers it (Save, Never for this site, or Not now) or it expires.
// - Nothing is offered or filled while an agent drives the tab; the agent signs in through request_credentials.
const crypto = require('node:crypto');
const { originOf } = require('./origins.cjs');
const { fillLogin, fieldScript, FIELD_FINDER, FILL_WORLD } = require('./userFill.cjs');
const { noteIgnored } = require('../../ignored.cjs');

/** Console signals from the fill world start with this, then the page's nonce. */
const SIGNAL = 'mopilot-login:';
/** How long an unanswered "Save password?" offer is kept. */
const OFFER_MS = 2 * 60_000;
/** How long after a sign-in main waits for the page to move on before checking the sign-in form is gone. */
const SETTLE_MS = 3000;
/** The fill world's global holding the dropdown and what the user signed in with. */
const KEY = '__mopilotLoginAssist';
/** Takes (and forgets) what the user last signed in with: { origin, username, password } or null. */
const TAKE = `(() => { const a = window.${KEY}; return a ? a.take() : null; })()`;

const CSS = `
:host { all: initial; }
.box { min-width: 220px; max-width: 320px; padding: 4px; border-radius: 12px; background: #fff; color: #1d1d1f;
  font: 13px/18px -apple-system, BlinkMacSystemFont, sans-serif; box-shadow: 0 6px 24px rgba(0,0,0,.18), 0 0 0 .5px rgba(0,0,0,.12); }
.item { padding: 6px 10px; border-radius: 8px; cursor: default; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item:hover, .item.active { background: rgba(0,0,0,.07); }
.foot { padding: 4px 10px 2px; color: #86868b; font-size: 11px; border-top: .5px solid rgba(0,0,0,.1); margin-top: 4px; }
@media (prefers-color-scheme: dark) {
  .box { background: #2c2c2e; color: #f5f5f7; box-shadow: 0 6px 24px rgba(0,0,0,.5), 0 0 0 .5px rgba(255,255,255,.14); }
  .item:hover, .item.active { background: rgba(255,255,255,.1); }
  .foot { color: #98989d; border-top-color: rgba(255,255,255,.12); }
}`;

/**
 * The fill world's script: installs the dropdown and the sign-in watcher once per page, or updates the saved user
 * names when it is already there.
 * @param {string} prefix SIGNAL and the page's nonce
 * @param {{ id: string, username: string }[]} logins the site's saved logins (no passwords)
 */
function assistScript(prefix, logins) {
  return `(() => {
  const saved = ${JSON.stringify(logins.map((l) => ({ id: l.id, username: l.username })))};
  if (window.${KEY}) return window.${KEY}.update(saved);
  const signal = (m) => console.log(${JSON.stringify(prefix)} + m);
  const find = () => {${FIELD_FINDER}
    return { user, pass };
  };
  let logins = saved;
  let menu = null;
  let stash = null;
  let sent = 0;
  const hide = () => {
    if (menu) menu.host.remove();
    menu = null;
  };
  const pick = (id) => {
    hide();
    signal('fill:' + id);
  };
  // the host is in the page's DOM, so the page could restyle or move it: a click counts only on the dropdown as drawn,
  // on top, under the field that still has the focus
  const intact = (e) => {
    const s = getComputedStyle(menu.host);
    const r = menu.host.getBoundingClientRect();
    const f = menu.field.getBoundingClientRect();
    return document.activeElement === menu.field && menu.host.style.cssText === menu.css && Number(s.opacity || 1) === 1 &&
      s.visibility !== 'hidden' && (s.transform || 'none') === 'none' && (s.filter || 'none') === 'none' &&
      Math.abs(r.left - f.left) < 2 && Math.abs(r.top - (f.bottom + 4)) < 2 && document.elementFromPoint(e.clientX, e.clientY) === menu.host;
  };
  const mark = (i) => {
    menu.active = i;
    menu.items.forEach((b, j) => b.classList.toggle('active', j === i));
  };
  const show = (field) => {
    hide();
    if (!logins.length) return;
    const host = document.createElement('mopilot-login-menu');
    const root = host.attachShadow({ mode: 'closed' });
    const r = field.getBoundingClientRect();
    host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; left: ' + Math.round(r.left) + 'px; top: ' + Math.round(r.bottom + 4) + 'px;';
    const style = document.createElement('style');
    style.textContent = ${JSON.stringify(CSS)};
    const box = document.createElement('div');
    box.className = 'box';
    box.setAttribute('role', 'listbox');
    const items = logins.map((l) => {
      const b = document.createElement('div');
      b.className = 'item';
      b.setAttribute('role', 'option');
      b.textContent = l.username || '(no user name)';
      // the field keeps the focus, so the dropdown doesn't close before the click
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => {
        if (!e.isTrusted) return;
        if (intact(e)) pick(l.id);
        else hide();
      });
      box.append(b);
      return b;
    });
    const foot = document.createElement('div');
    foot.className = 'foot';
    foot.textContent = 'Saved in MoPilot';
    box.append(foot);
    root.append(style, box);
    document.documentElement.append(host);
    menu = { host, field, items, ids: logins.map((l) => l.id), active: -1, css: host.style.cssText };
  };
  const loginField = (t) => {
    const { user, pass } = find();
    return !!t && (t === user || t === pass);
  };
  // what the user signs in with stays in this world until main takes it
  const capture = () => {
    const { user, pass } = find();
    if (!pass || !pass.value) return;
    stash = { origin: location.origin, username: user ? user.value : '', password: pass.value };
    const now = Date.now();
    if (now - sent > 500) signal('submitted');
    sent = now;
  };
  document.addEventListener('focusin', (e) => {
    if (!e.isTrusted) return;
    if (loginField(e.target)) show(e.target);
    else hide();
  }, true);
  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    if (!menu && loginField(e.target)) return show(e.target);
    if (e.target && e.target.closest && e.target.closest('button, input[type=submit], input[type=image], [role=button]')) capture();
  }, true);
  document.addEventListener('focusout', (e) => menu && e.target === menu.field && hide(), true);
  document.addEventListener('input', (e) => menu && e.target === menu.field && hide(), true);
  document.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
  document.addEventListener('submit', (e) => e.isTrusted && capture(), true);
  document.addEventListener('keydown', (e) => {
    // keys an input method is using (Enter confirms a candidate) are the page's
    if (!e.isTrusted || e.isComposing || e.keyCode === 229) return;
    if (menu && e.target === menu.field) {
      const n = menu.items.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        return mark(e.key === 'ArrowDown' ? (menu.active + 1) % n : (menu.active - 1 + n) % n);
      }
      if (e.key === 'Escape') return hide();
      if (e.key === 'Enter' && menu.active >= 0) {
        e.preventDefault();
        e.stopPropagation();
        return pick(menu.ids[menu.active]);
      }
    }
    if (e.key === 'Enter' && loginField(e.target)) capture();
  }, true);
  window.${KEY} = {
    update: (l) => {
      logins = l;
      hide();
    },
    take: () => {
      const s = stash;
      stash = null;
      return s;
    },
  };
})()`;
}

/**
 * @param {{ store: () => any, confirm: (host: string) => Promise<boolean>, isAgent: (wc: any) => boolean,
 *           enabled?: () => boolean, notify: (wc: any, detail: Record<string, unknown>) => void, offerMs?: number,
 *           settleMs?: number }} o
 *   store: MoPilot's own login store (credentialStore.cjs)
 *   confirm: asks the user (Touch ID) before a password is filled
 *   isAgent: whether an agent drives the page now (nothing is offered or filled then)
 *   enabled: the shared.browser.loginAssist flag
 *   notify: tells the pane showing the page: { kind: 'offer', offerId, host, username, update }, { kind: 'offer_gone', offerId } or
 *     { kind: 'fill', status } for a fill that failed
 */
function createLoginAssist({ store, confirm, isAgent, enabled = () => true, notify, offerMs = OFFER_MS, settleMs = SETTLE_MS }) {
  /** webContents id -> { wc, origin, username, password, update, timer } */
  const offers = new Map();
  /** webContents id -> a sign-in waiting to look accepted: { wc, login, timer } */
  const pending = new Map();
  /** webContents id -> the page's re-injection, so a saved login shows in its dropdown at once */
  const pages = new Map();

  const drop = (id, tell = false) => {
    const o = offers.get(id);
    if (!o) return;
    clearTimeout(o.timer);
    offers.delete(id);
    if (tell && !o.wc.isDestroyed()) notify(o.wc, { kind: 'offer_gone', offerId: o.offerId });
  };

  const unpend = (id) => {
    const p = pending.get(id);
    if (p) clearTimeout(p.timer);
    pending.delete(id);
    return p;
  };

  const offer = (wc, login) => {
    drop(wc.id);
    const timer = setTimeout(() => drop(wc.id, true), offerMs);
    timer.unref?.();
    // the bar answers the offer it showed: a newer sign-in on the page replaces it under another id
    const offerId = crypto.randomUUID();
    offers.set(wc.id, { wc, ...login, offerId, timer });
    notify(wc, { kind: 'offer', offerId, host: new URL(login.origin).host, username: login.username, update: login.update });
  };

  /** A sign-in looks accepted when the page navigated, or (after a moment) its password field is gone. */
  const settle = async (id, navigated) => {
    const p = unpend(id);
    if (!p || p.wc.isDestroyed()) return;
    if (!navigated) {
      try {
        const left = await p.wc.executeJavaScriptInIsolatedWorld(FILL_WORLD, [{ code: fieldScript('probe') }]);
        // the sign-in form is still there: the site likely refused the password
        if (left?.password) return;
      } catch (error) {
        return noteIgnored('check a sign-in form is gone', error);
      }
    }
    offer(p.wc, p.login);
  };

  const submitted = async (wc) => {
    let got;
    try {
      got = await wc.executeJavaScriptInIsolatedWorld(FILL_WORLD, [{ code: TAKE }]);
    } catch (error) {
      // the page went away before main asked: nothing is offered
      return noteIgnored('read a sign-in to offer saving its password', error);
    }
    const origin = originOf(typeof got?.origin === 'string' ? got.origin : '');
    if (!origin || typeof got.password !== 'string' || !got.password || typeof got.username !== 'string') return;
    const s = store();
    if (!s.available() || s.isNever(origin)) return;
    const same = s.list(origin).find((l) => l.username === got.username);
    if (same && s.get(same.id, origin)?.password === got.password) return;
    unpend(wc.id);
    const timer = setTimeout(() => void settle(wc.id, false), settleMs);
    timer.unref?.();
    pending.set(wc.id, { wc, login: { origin, username: got.username, password: got.password, update: !!same }, timer });
  };

  const onSignal = async (wc, message) => {
    if (!enabled() || isAgent(wc)) return;
    if (message === 'submitted') return submitted(wc);
    if (!message.startsWith('fill:')) return;
    const status = await fillLogin({ wc, store: store(), id: message.slice(5), confirm });
    if (status !== 'filled' && status !== 'cancelled') notify(wc, { kind: 'fill', status });
  };

  return {
    /** Watches a browser tab's page (a pane view, a popup or a legacy guest). */
    attach(wc) {
      const prefix = `${SIGNAL}${crypto.randomUUID()}:`;
      const inject = () => {
        const origin = !wc.isDestroyed() && enabled() ? originOf(wc.getURL()) : null;
        if (!origin) return;
        // a tab an agent drives gets no dropdown (it would only show in the agent's screenshots); sign-ins are still ignored
        const logins = isAgent(wc) ? [] : store().list(origin);
        Promise.resolve(wc.executeJavaScriptInIsolatedWorld(FILL_WORLD, [{ code: assistScript(prefix, logins) }])).catch((error) =>
          noteIgnored('install saved-login help in a page', error),
        );
      };
      pages.set(wc.id, inject);
      wc.on('dom-ready', inject);
      // a sign-in followed by a navigation was accepted
      wc.on('did-navigate', () => void settle(wc.id, true));
      wc.on('did-navigate-in-page', (_e, _url, isMainFrame) => isMainFrame !== false && void settle(wc.id, true));
      wc.on('console-message', (e) => {
        const message = String(e?.message ?? '');
        if (message.startsWith(prefix)) void onSignal(wc, message.slice(prefix.length));
      });
      wc.once('destroyed', () => {
        unpend(wc.id);
        drop(wc.id);
        pages.delete(wc.id);
      });
    },
    /**
     * The user's answer to the page's offer `offerId` (the one its bar showed): 'save', 'never' (this site) or anything
     * else for Not now. Resolves to 'saved', 'never', 'dismissed', 'gone' (that offer is no longer the page's: it
     * expired or a newer sign-in replaced it, which stays offered) or 'failed'.
     */
    answer(id, choice, offerId) {
      const o = offers.get(id);
      if (!o || o.offerId !== offerId) return 'gone';
      // every window showing the page closes its bar
      drop(id, true);
      if (choice === 'save') {
        if (!store().save(o.origin, o.username, o.password)) return 'failed';
        pages.get(id)?.();
        return 'saved';
      }
      if (choice === 'never') return store().setNever(o.origin) ? 'never' : 'failed';
      return 'dismissed';
    },
  };
}

module.exports = { createLoginAssist, assistScript, SIGNAL, OFFER_MS, SETTLE_MS, KEY };
