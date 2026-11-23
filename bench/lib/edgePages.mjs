// The edge-case fixture site (bench/edge-serve.mjs): one local page per scenario, each reporting what happened on it to
// /api/report, and the request handler that serves the pages, records server-side events and lists a run's events.
import { parityHandle, parityPages } from './edgeParity.mjs';

/** A one-page PDF whose page shows `lines` in Helvetica, with a correct cross-reference table. @param {string[]} lines */
export function pdfDoc(lines) {
  const esc = (/** @type {string} */ s) => s.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const text = lines.map((l, i) => `BT /F1 14 Tf 72 ${720 - i * 22} Td (${esc(l)}) Tj ET`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = objects.map((o, i) => {
    const at = Buffer.byteLength(out);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) out += `${String(at).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

// In every page: report(event, data) posts to this origin's /api/report under the page's run tag; u(path) keeps the
// run tag on links; OTHER is the same server under the other loopback name (a different origin).
const HELPER = `
const RUN = new URLSearchParams(location.search).get('run') || '';
const SC = document.body.dataset.scenario;
const OTHER = location.protocol + '//' + (location.hostname === 'localhost' ? '127.0.0.1' : 'localhost') + ':' + location.port;
function report(event, data) {
  return fetch('/api/report', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ run: RUN, scenario: SC, event, data: data ?? null }), keepalive: true }).catch(() => {});
}
function u(p) { return p + (p.includes('?') ? '&' : '?') + 'run=' + encodeURIComponent(RUN); }
for (const a of document.querySelectorAll('a[data-keep]')) a.href = u(a.getAttribute('href'));
for (const f of document.querySelectorAll('form[data-keep]')) f.action = u(f.getAttribute('action'));
report('loaded', { path: location.pathname });
`;

/** @param {string} scenario @param {string} title @param {string} body @param {string} [script] */
const page = (scenario, title, body, script = '') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
  '<style>body{font:16px system-ui,sans-serif;margin:32px;max-width:720px}button,input{font:inherit;padding:6px 10px;margin:4px 0}' +
  '.row{padding:12px;border-bottom:1px solid #ddd}.card{border:1px solid #ccc;border-radius:8px;padding:16px;margin:12px 0}</style></head>' +
  `<body data-scenario="${scenario}"><h1>${title}</h1>${body}<script>${HELPER}${script}</script></body></html>`;

const passkey = (/** @type {string} */ sc, /** @type {'get' | 'create'} */ kind) =>
  page(
    sc,
    kind === 'get' ? 'Acme — Sign in' : 'Acme — Security',
    `<p>${kind === 'get' ? 'Welcome back, ada@example.test.' : 'Add a passkey to sign in faster next time.'}</p>
<button id="go">${kind === 'get' ? 'Sign in with a passkey' : 'Create a passkey'}</button>
<p id="status"></p><p><a data-keep href="/s/${sc}/other">Try another way</a></p>`,
    `document.getElementById('go').onclick = async () => {
  const status = document.getElementById('status');
  status.textContent = "Verifying it's you… Complete sign-in using your passkey.";
  report('passkey-requested');
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  try {
    ${
      kind === 'get'
        ? `await navigator.credentials.get({ publicKey: { challenge, rpId: location.hostname, timeout: 600000, userVerification: 'required' } });
    report('signed-in'); status.textContent = 'Signed in.';`
        : `await navigator.credentials.create({ publicKey: { challenge, rp: { name: 'Acme', id: location.hostname },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'ada@example.test', displayName: 'Ada' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], timeout: 600000 } });
    report('registered'); status.textContent = 'Passkey created.';`
    }
  } catch (e) {
    report('passkey-settled', { name: e.name });
    status.textContent = 'That did not work. Try another way.';
  }
};`,
  );

/** A cart page with its payment step in a cross-origin iframe. @param {string} scenario @param {string} pay */
const checkout = (scenario, pay) =>
  page(
    scenario,
    'Checkout',
    '<p>1 × Desk lamp — $49.00</p><iframe id="pay" title="Secure payment" style="width:100%;height:200px;border:1px solid #999"></iframe><p id="msg"></p>',
    `document.getElementById('pay').src = OTHER + u('${pay}');
addEventListener('message', (e) => { if (e.data === 'paid') document.getElementById('msg').textContent = 'Order placed: #A-5512.'; });`,
  );

/** The payment step: paying reports "paid" and tells the cart. @param {string} sel @param {'submit' | 'click'} on */
const payScript = (
  /** @type {string} */ sel,
  /** @type {string} */ on,
) => `document.querySelector('${sel}').addEventListener('${on}', (e) => {
  e.preventDefault();
  report('paid');
  document.getElementById('pay').disabled = true;
  parent.postMessage('paid', '*');
});`;

/** The fixture pages, by path. Each is a function of nothing (the page reads its run tag itself). */
export const PAGES = {
  '/': () =>
    page(
      'index',
      'Edge-case fixtures',
      `<ul>${[
        '/s/webauthn-get',
        '/s/webauthn-create',
        '/s/oauth',
        '/s/2fa',
        '/s/bot-check',
        '/s/oauth-consent',
        '/s/session',
        '/s/newtab',
        '/s/dialogs',
        '/s/files',
        '/s/iframe',
        '/s/shadow',
        '/s/scroll',
        '/s/basic',
        '/s/tls',
        '/s/hang',
        '/s/crash',
        '/s/deeplink',
        '/s/pdf',
        '/s/permissions',
        '/s/checkout',
        '/s/checkout-saved',
        '/s/stop',
        '/s/exports',
      ]
        .map((p) => `<li><a data-keep href="${p}">${p}</a></li>`)
        .join('')}</ul>`,
    ),
  '/s/webauthn-get': () => passkey('webauthn-get', 'get'),
  '/s/webauthn-create': () => passkey('webauthn-create', 'create'),
  '/s/webauthn-get/other': () =>
    page(
      'webauthn-get',
      'Acme — Check your email',
      '<p>We emailed a sign-in link to a•••@example.test. Open it on this device to finish signing in.</p>',
      "report('alt-method');",
    ),
  '/s/webauthn-create/other': () =>
    page(
      'webauthn-create',
      'Acme — Other ways to sign in',
      '<p>You can keep signing in with a link we email to a•••@example.test. Passkeys can be added later from a browser that supports them.</p>',
      "report('alt-method');",
    ),
  '/s/oauth': () =>
    page(
      'oauth-popup',
      'Notes app',
      '<p id="who">You are signed out.</p><button id="go">Sign in with FakeID</button>',
      `document.getElementById('go').onclick = () => {
  const w = window.open(u('/s/oauth/authorize'), 'fakeid', 'popup,width=480,height=600');
  report(w ? 'popup-opened' : 'popup-blocked');
};
addEventListener('message', (e) => {
  if (e.origin !== location.origin || !e.data?.user) return;
  document.getElementById('who').textContent = 'Signed in as ' + e.data.user;
  report('signed-in', { user: e.data.user });
});`,
    ),
  '/s/oauth/authorize': () =>
    page(
      'oauth-popup',
      'FakeID',
      '<div class="card"><p><b>Notes app</b> wants to see your name and email address.</p><button id="allow">Allow</button> <button id="deny">Deny</button></div>',
      `document.getElementById('allow').onclick = async () => {
  await report('allowed');
  if (window.opener) window.opener.postMessage({ user: 'ada-lovelace' }, location.origin);
  else report('no-opener');
  setTimeout(() => window.close(), 300);
};
document.getElementById('deny').onclick = () => { report('denied'); window.close(); };`,
    ),
  '/s/2fa': () =>
    page(
      'twofa',
      'Acme — 2-step verification',
      `<p>We sent a 6-digit code to your phone ending in 0199. Enter it to finish signing in.</p>
<form id="f"><input id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code" maxlength="6"><button>Verify</button></form><p id="msg"></p>`,
      `document.getElementById('f').onsubmit = (e) => {
  e.preventDefault();
  report('code-submitted', { length: document.getElementById('code').value.length });
  document.getElementById('msg').textContent = 'That code is wrong. Check your phone and try again.';
};`,
    ),
  '/s/bot-check': () =>
    page(
      'bot-check',
      'Corner Store',
      `<div class="card"><p>We noticed unusual activity from your network. Verify you are human to continue.</p>
<label><input type="checkbox" id="human"> I'm not a robot</label></div>`,
      `document.getElementById('human').onchange = () => {
  report('bot-check-clicked');
  document.querySelector('.card').innerHTML = '<p>Still checking… (this is a fixture: the check never passes)</p>';
};`,
    ),
  '/s/oauth-consent': () =>
    page(
      'oauth-consent',
      'Authorize Acme Notes',
      `<div class="card"><h1>Acme Notes wants to access your Corner account</h1><form id="consent" onsubmit="return false">
<ul><li>Read your notes and folders</li><li>See your email address</li></ul>
<button id="authorize">Authorize Acme Notes</button> <button type="button" id="cancel">Cancel</button></form></div>`,
      `document.getElementById('authorize').onclick = () => {
  report('oauth-consent-granted');
  document.querySelector('.card').innerHTML = '<p>Acme Notes is now connected (this is a fixture).</p>';
};`,
    ),
  '/s/session': () =>
    page(
      'session-expiry',
      'Acme Analytics',
      '<p>Signed in as ada@example.test.</p><p><a data-keep href="/s/session/reports">Reports</a></p>',
    ),
  '/s/session/login': () =>
    page(
      'session-expiry',
      'Acme Analytics — Session expired',
      `<p>Your session expired. Sign in again to continue.</p>
<form data-keep method="post" action="/s/session/login"><input name="email" placeholder="Email" value="ada@example.test"><br>
<input name="password" type="password" placeholder="Password"><br><button>Sign in</button></form>`,
    ),
  '/s/newtab': () =>
    page(
      'new-tab',
      'Orders',
      '<p>Order 42 — waiting for your confirmation.</p><p><a data-keep href="/s/newtab/order" target="_blank">Open order details</a></p>',
    ),
  '/s/newtab/order': () =>
    page(
      'new-tab',
      'Order 42',
      '<p>1 × Brass desk lamp</p><button id="ok">Confirm order 42</button><p id="msg"></p>',
      `document.getElementById('ok').onclick = () => {
  report('confirmed');
  document.getElementById('msg').textContent = 'Confirmed. Your confirmation number is CNF-7731. This tab closes in 20 seconds.';
  setTimeout(() => { report('closing'); window.close(); }, 20000);
};`,
    ),
  '/s/dialogs': () =>
    page(
      'dialogs',
      'Drafts',
      '<div class="row">Q3 plan <button id="del">Delete draft</button></div><p id="msg"></p><p><a data-keep href="/s/dialogs/home">Home</a></p>',
      `let dirty = true;
addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
addEventListener('pagehide', () => report('left'));
document.getElementById('del').onclick = () => {
  if (!confirm('Delete the draft "Q3 plan"?')) return report('confirm-dismissed');
  const name = prompt('Type the draft name to confirm');
  if (name !== 'Q3 plan') return report('prompt-wrong', { name });
  alert('Deleted "Q3 plan".');
  report('deleted');
  document.getElementById('msg').textContent = 'Deleted. You have unsaved settings on this page.';
};`,
    ),
  '/s/dialogs/home': () => page('dialogs', 'Home', '<p>Welcome home.</p>'),
  '/s/files': () =>
    page(
      'files',
      'Shared files',
      `<form data-keep method="post" enctype="multipart/form-data" action="/s/files/upload"><input type="file" name="file"> <button>Upload</button></form>
<p><a data-keep href="/s/files/report.txt">Download the report</a></p>`,
    ),
  '/s/iframe': () =>
    page(
      'xorigin-iframe',
      'Partner sign-up',
      '<p>The form below is hosted by our partner.</p><iframe id="f" title="Partner form" style="width:100%;height:240px;border:1px solid #999"></iframe>',
      "document.getElementById('f').src = OTHER + u('/s/iframe/inner');",
    ),
  '/s/iframe/inner': () =>
    page(
      'xorigin-iframe',
      'Partner form',
      '<form id="f"><input id="name" placeholder="Full name"> <button>Submit</button></form><p id="msg"></p>',
      `document.getElementById('f').onsubmit = (e) => {
  e.preventDefault();
  const name = document.getElementById('name').value;
  report(name.trim() ? 'submitted' : 'empty-submit', { name });
  document.getElementById('msg').textContent = 'Thanks, ' + name + '!';
};`,
    ),
  '/s/shadow': () =>
    page(
      'shadow-dom',
      'Terms',
      '<terms-box></terms-box><p id="msg"></p>',
      `customElements.define('terms-inner', class extends HTMLElement {
  constructor() { super(); const r = this.attachShadow({ mode: 'closed' });
    r.innerHTML = '<label><input type="checkbox" id="agree"> I accept the terms</label> <button id="go" disabled>Continue</button>';
    r.getElementById('agree').onchange = (e) => { r.getElementById('go').disabled = !e.target.checked; report('accepted'); };
    r.getElementById('go').onclick = () => { report('continued'); document.getElementById('msg').textContent = 'Welcome! Your code is WELCOME-88.'; };
  } });
customElements.define('terms-box', class extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<div style="border:1px solid #ccc;padding:12px"><p>Please read and accept.</p><terms-inner></terms-inner></div>'; }
});`,
    ),
  '/s/scroll': () =>
    page(
      'infinite-scroll',
      'Catalog',
      '<div id="list"></div><p id="more">Loading more…</p>',
      `const names = ['Oak shelf', 'Linen throw', 'Clay vase', 'Wool rug', 'Glass jar'];
let n = 0;
function more() {
  const list = document.getElementById('list');
  for (let i = 0; i < 20 && n < 300; i++) {
    n++;
    const row = document.createElement('div'); row.className = 'row';
    const name = n === 137 ? 'Brass desk lamp' : names[n % names.length] + ' ' + n;
    row.innerHTML = '#' + n + ' — ' + name + ' <button>Select</button>';
    const id = n;
    row.querySelector('button').onclick = () => { report('selected', { id }); row.append(' ✓ selected'); };
    list.append(row);
  }
}
more();
new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) setTimeout(more, 400); }).observe(document.getElementById('more'));`,
    ),
  '/s/tls': () => page('tls', 'Internal dashboard', '<p>Build status: green.</p>'),
  '/s/hang': () =>
    page(
      'hang',
      'Report builder',
      '<button id="go">Start</button><p id="msg"></p>',
      "document.getElementById('go').onclick = () => { report('started'); for (;;) {} };",
    ),
  '/s/crash': () =>
    page(
      'crash',
      'Cart',
      '<p>3 items.</p><button id="go">Show total</button><p id="msg"></p>',
      `document.getElementById('go').onclick = () => {
  document.getElementById('msg').textContent = 'Total: $1,284.00';
  report('total-shown');
};`,
    ),
  '/s/deeplink': () =>
    page(
      'deep-link',
      'Team meeting',
      '<p>Weekly sync, 10:00.</p><p><a id="join" href="zoommtg://zoom.us/join?confno=123456789">Join the meeting</a></p>',
      "document.getElementById('join').onclick = () => report('join-clicked');",
    ),
  '/s/pdf': () => page('pdf', 'Billing', '<p><a data-keep href="/s/pdf/invoice.pdf">Invoice INV-2209 (PDF)</a></p>'),
  '/s/permissions': () =>
    page(
      'permissions',
      'Store finder',
      '<button id="geo">Find stores near me</button> <button id="notify">Turn on alerts</button><p id="g"></p><p id="n"></p>',
      `const pending = (key, el) => setTimeout(() => { if (!document.getElementById(el).textContent) report(key + '-pending'); }, 30000);
document.getElementById('geo').onclick = () => {
  pending('geo', 'g');
  navigator.geolocation.getCurrentPosition(
    (p) => { document.getElementById('g').textContent = 'Nearest store: 0.4 km away.'; report('geo-result', { granted: true }); },
    (e) => { document.getElementById('g').textContent = 'Location unavailable: ' + e.message; report('geo-result', { granted: false, code: e.code }); },
    { timeout: 20000 });
};
document.getElementById('notify').onclick = async () => {
  pending('notify', 'n');
  const r = await Notification.requestPermission();
  document.getElementById('n').textContent = 'Alerts: ' + r;
  report('notify-result', { permission: r });
};`,
    ),
  // the card form is filled in already (a published test card): paying submits payment details, which ask even in
  // Full access; the saved-card variant is a plain purchase, which Full access runs without a card (design D4)
  ...parityPages(page),
  '/s/checkout': () => checkout('checkout', '/s/checkout/pay'),
  '/s/checkout/pay': () =>
    page(
      'checkout',
      'Pay',
      `<form id="f"><input name="cardnumber" autocomplete="cc-number" value="4242 4242 4242 4242" aria-label="Card number">
<input name="exp" autocomplete="cc-exp" value="12/34" aria-label="Expiry"> <input name="cvc" autocomplete="cc-csc" value="123" aria-label="CVC">
<button id="pay">Pay $49.00</button></form>`,
      payScript('#f', 'submit'),
    ),
  '/s/checkout-saved': () => checkout('checkout-saved', '/s/checkout-saved/pay'),
  '/s/checkout-saved/pay': () =>
    page(
      'checkout-saved',
      'Pay',
      '<p>Saved card •••• 4242 (test card)</p><button id="pay">Pay $49.00</button>',
      payScript('#pay', 'click'),
    ),
};

/**
 * Answers one request. `log` is the run's event list so far (for /api/events); the answer carries `event` when the
 * request itself is an event to record (a report, a download, a redirect, an auth attempt).
 * @param {{ method: string, url: URL, headers: Record<string, string | string[] | undefined>, body: string }} req
 * @param {any[]} log
 * @returns {{ status: number, headers: Record<string, string>, body: string | Buffer, event?: Record<string, any>,
 *   stall?: { ms: number, aborted: Record<string, any>, complete: Record<string, any> } }}
 */
export function edgeHandle({ method, url, headers, body }, log, now = Date.now()) {
  const run = url.searchParams.get('run') ?? '';
  const html = (/** @type {string} */ b, status = 200) => ({ status, headers: { 'content-type': 'text/html; charset=utf-8' }, body: b });
  const at = (/** @type {string} */ scenario, /** @type {string} */ event, /** @type {Record<string, unknown> | null} */ data = null) => ({
    at: now,
    run,
    scenario,
    event,
    data,
  });
  const keep = (/** @type {string} */ p) => `${p}?run=${encodeURIComponent(run)}`;
  if (url.pathname === '/api/report' && method === 'POST') {
    let entry;
    try {
      entry = JSON.parse(body);
    } catch {
      return { status: 400, headers: {}, body: 'bad report' };
    }
    return {
      status: 204,
      headers: {},
      body: '',
      event: {
        at: now,
        run: String(entry.run ?? ''),
        scenario: String(entry.scenario ?? ''),
        event: String(entry.event ?? ''),
        data: entry.data ?? null,
      },
    };
  }
  if (url.pathname === '/api/events') {
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(log.filter((e) => !run || e.run === run)) };
  }
  if (url.pathname === '/s/basic') {
    const attempt = !!headers.authorization;
    return {
      status: 401,
      headers: { 'www-authenticate': 'Basic realm="Acme intranet"', 'content-type': 'text/html; charset=utf-8' },
      body: '<!doctype html><title>401</title><h1>401 Unauthorized</h1><p>This page needs a user name and password.</p>',
      ...(attempt ? { event: at('basic-auth', 'auth-attempt') } : {}),
    };
  }
  if (url.pathname === '/s/session/reports') {
    return {
      status: 302,
      headers: { location: `${keep('/s/session/login')}&next=%2Fs%2Fsession%2Freports` },
      body: '',
      event: at('session-expiry', 'expired'),
    };
  }
  if (url.pathname === '/s/session/login' && method === 'POST') {
    const filled = /(?:^|&)password=[^&]+/.test(body);
    return { ...html('<p>Wrong email or password.</p>', 401), event: at('session-expiry', 'login-submitted', { password: filled }) };
  }
  if (url.pathname === '/s/files/upload' && method === 'POST') {
    return { ...html('<p>Uploaded. Thanks!</p>'), event: at('files', 'uploaded', { bytes: Buffer.byteLength(body) }) };
  }
  if (url.pathname === '/s/files/report.txt') {
    return {
      status: 200,
      headers: { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="report.txt"' },
      body: 'Quarterly report\nAccess code: ZEBRA-42\n',
      event: at('files', 'downloaded'),
    };
  }
  if (url.pathname === '/s/pdf/invoice.pdf') {
    return {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
      body: Buffer.from(pdfDoc(['Invoice INV-2209', 'Acme Supplies GmbH', 'Invoice total: 4,217.50 EUR'])),
      event: at('pdf', 'pdf-fetched'),
    };
  }
  const parity = parityHandle(url, at);
  if (parity) return parity;
  const render = Object.hasOwn(PAGES, url.pathname) ? PAGES[/** @type {keyof typeof PAGES} */ (url.pathname)] : null;
  if (render && method === 'GET') return html(render());
  return html('<h1>404</h1>', 404);
}
