// MoPilot 12-Grid Bench (#1381) onboarding fixtures for F2: a four-step HR wizard (onboard.localhost) with server-side
// validation, an identity check in a cross-origin iframe (idcheck.localhost), a PDF upload and a signed-copy download.
import { createHmac } from 'node:crypto';
import { pdfDoc } from '../../edgePages.mjs';
import { isDate } from './records.mjs';
import { bytes, field, flashOf, html, logEvent, nextId, notFound, ok, page, parseBody, raw, redirect, route, withFlash } from './kit.mjs';

/** The check digit of a document number: the digits' weighted sum (weights 7, 3, 1) mod 10. @param {string} digits */
export const idCheckDigit = (digits) => String([...digits].reduce((s, d, i) => s + Number(d) * [7, 3, 1][i % 3], 0) % 10);
/** A valid ID document number: two letters, six digits, a check digit. @param {string} s */
export const validDocNumber = (s) => /^[A-Z]{2}\d{7}$/.test(s) && idCheckDigit(s.slice(2, 8)) === s[8];
/** IBAN-style mod-97 check of a bank account: "MG" + 2 check digits + 12 digits. @param {string} s */
export function validAccount(s) {
  const v = s.replace(/\s+/g, '').toUpperCase();
  if (!/^MG\d{14}$/.test(v)) return false;
  const moved = `${v.slice(4)}2216${v.slice(2, 4)}`; // M=22, G=16
  return BigInt(moved) % 97n === 1n;
}
/** The check digits that make "MG??" + 12 digits valid. @param {string} digits12 */
export const accountFor = (digits12) => `MG${String(98n - (BigInt(`${digits12}221600`) % 97n)).padStart(2, '0')}${digits12}`;
/**
 * The token idcheck hands the wizard for one application and document: "<doc>.<signature>". The wizard checks the
 * signature with the secret both share, so neither site reads the other's state and the agent cannot forge one.
 * @param {string} secret @param {string} app @param {string} doc
 */
export const idToken = (secret, app, doc) => `${doc}.${createHmac('sha256', secret).update(`${app}|${doc}`).digest('hex').slice(0, 24)}`;
/** The document a token verifies for an application, or null. @param {string} secret @param {string} app @param {string} token */
export function verifiedDoc(secret, app, token) {
  const doc = token.split('.')[0];
  return validDocNumber(doc) && token === idToken(secret, app, doc) ? doc : null;
}

const STEPS = ['Personal details', 'Employment and identity', 'Bank and tax', 'Documents and review'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The wizard's state from a fixture: `{ secret, company, today, departments: string[], directory: string[] (manager
 * emails) }`. `secret` is shared with the idcheck fixture.
 * @param {any} f
 */
export function initOnboard(f) {
  if (typeof f?.secret !== 'string' || f.secret.length < 8) throw new Error('onboard fixture needs a secret');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.today ?? '')) throw new Error('onboard fixture needs today (YYYY-MM-DD)');
  if (!Array.isArray(f.departments) || !f.departments.length || !Array.isArray(f.directory))
    throw new Error('onboard fixture needs departments and a directory');
  return {
    secret: f.secret,
    company: String(f.company ?? 'Acme'),
    today: f.today,
    departments: f.departments,
    directory: f.directory.map((e) => String(e).toLowerCase()),
    applications: /** @type {any[]} */ ([]),
    seq: 0,
    events: /** @type {any[]} */ ([]),
  };
}

/** What one step's fields must satisfy: a list of [field, message] errors. @param {any} s @param {number} n @param {Record<string, string>} v @param {any} a */
export function stepErrors(s, n, v, a) {
  /** @type {[string, string][]} */
  const e = [];
  if (n === 1) {
    if (!v.name || v.name.split(/\s+/).length < 2) e.push(['name', 'Enter a first and last name.']);
    if (!EMAIL.test(v.email)) e.push(['email', 'Enter a valid email address.']);
    if (!isDate(v.dob)) e.push(['dob', 'Date of birth must be a date written YYYY-MM-DD.']);
    // calendar years: the 18th birthday is the same month and day 18 years on (29 February counts from 1 March)
    else if (`${Number(v.dob.slice(0, 4)) + 18}${v.dob.slice(4)}` > s.today) e.push(['dob', 'The applicant must be 18 or older.']);
    if (!/^\+\d{7,14}$/.test(v.phone.replace(/[\s-]/g, '')))
      e.push(['phone', 'Phone must be in international format, e.g. +351 912 345 678.']);
  } else if (n === 2) {
    if (!s.departments.includes(v.department)) e.push(['department', 'Choose a department.']);
    const start = /^\d{4}-\d{2}-\d{2}$/.test(v.start) ? new Date(`${v.start}T12:00:00Z`) : null;
    if (!start || Number.isNaN(start.getTime()) || start.getUTCDay() !== 1 || v.start <= s.today)
      e.push(['start', 'The start date must be a Monday after today.']);
    if (!s.directory.includes(v.manager.toLowerCase())) e.push(['manager', 'The manager is not in the company directory.']);
    if (!verifiedDoc(s.secret, a.id, v.idToken)) e.push(['idToken', 'Verify the identity document first.']);
  } else if (n === 3) {
    if (!validAccount(v.account)) e.push(['account', 'The bank account number is not valid.']);
    if (!/^\d{3}-\d{3}-\d{3}$/.test(v.tax)) e.push(['tax', 'Tax number must look like 123-456-789.']);
  }
  return e;
}

const FIELDS = { 1: ['name', 'email', 'dob', 'phone', 'address'], 2: ['department', 'start', 'manager', 'idToken'], 3: ['account', 'tax'] };
const TITLE = 'Onboarding';
const find = (/** @type {any} */ s, /** @type {string} */ id) => s.applications.find((/** @type {any} */ a) => a.id === id);
/** The first step not yet done. @param {any} a */
const nextStep = (a) => [1, 2, 3].find((n) => !a.done.includes(n)) ?? 4;

/** @param {any} s @param {any} a @param {number} n @param {URL} url @param {[string, string][]} errors @param {Record<string, string>} v */
function stepPage(s, a, n, url, errors = [], v = a.values) {
  const input = (/** @type {string} */ name, /** @type {string} */ label, type = 'text') =>
    html`<label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}" value="${v[name] ?? ''}" aria-invalid="${errors.some(([f]) => f === name) ? 'true' : 'false'}">`;
  const idOrigin = url.origin.replace('://onboard.', '://idcheck.');
  const body = {
    1: html`${input('name', 'Full name')}${input('email', 'Personal email', 'email')}${input('dob', 'Date of birth (YYYY-MM-DD)')}${input('phone', 'Mobile phone')}${input('address', 'Home address')}`,
    2: html`<label for="department">Department</label><select id="department" name="department"><option value="">Choose…</option>${s.departments.map((d) => html`<option ${d === v.department ? raw('selected') : ''}>${d}</option>`)}</select>
${input('start', 'Start date (YYYY-MM-DD)')}${input('manager', 'Manager email', 'email')}
<input type="hidden" id="idToken" name="idToken" value="${v.idToken ?? ''}"><p id="id-status">${verifiedDoc(s.secret, a.id, v.idToken ?? '') ? `Identity verified (document ending ${String(v.idToken).slice(5, 9)})` : 'Identity not verified yet.'}</p>
<iframe title="Identity check" src="${idOrigin}/verify?app=${a.id}" width="520" height="230"></iframe>
<script>addEventListener('message',e=>{if(e.origin!==${raw(JSON.stringify(idOrigin))}||e.data?.type!=='idcheck')return;document.getElementById('idToken').value=e.data.token;document.getElementById('id-status').textContent='Identity verified (document ending '+e.data.last4+')';});</script>`,
    3: html`${input('account', 'Bank account (MG + 16 digits)')}${input('tax', 'Tax number')}`,
    4: html`<dl>${FIELDS[1].concat(FIELDS[3], ['department', 'start', 'manager']).map((k) => html`<dt>${k}</dt><dd>${a.values[k] ?? ''}</dd>`)}</dl>
<label for="declaration">Signed declaration (PDF)</label><input id="declaration" type="file" name="declaration" accept="application/pdf">
${a.declaration ? html`<p>Uploaded: ${a.declaration.name}</p>` : ''}<label><input type="checkbox" name="agree" value="yes"> I confirm these details are correct</label>`,
  }[n];
  return ok(
    page({
      app: `${s.company} ${TITLE}`,
      title: STEPS[n - 1],
      flash: flashOf(url),
      error: errors.length ? `Please fix: ${errors.map(([, m]) => m).join(' ')}` : null,
      body: html`<p class="muted">Step ${n} of 4 · Application ${a.id}</p><h1>${STEPS[n - 1]}</h1>
<form method="post" action="/a/${a.id}/step/${n}"${n === 4 ? raw(' enctype="multipart/form-data"') : ''}>${body}
<p>${n > 1 ? html`<a href="/a/${a.id}/step/${n - 1}">Back</a> ` : ''}<button>${n === 4 ? 'Submit application' : 'Continue'}</button></p></form>`,
    }),
  );
}

/** @type {[string, string, (req: any, s: any, p: Record<string, string>, now: number) => any][]} */
const ROUTES = [
  [
    'GET',
    '/',
    (req, s) =>
      ok(
        page({
          app: `${s.company} ${TITLE}`,
          title: 'Start',
          flash: flashOf(req.url),
          body: html`<h1>New hire onboarding</h1><form method="post" action="/start"><button>Start a new application</button></form>`,
        }),
      ),
  ],
  [
    'POST',
    '/start',
    (_req, s, _p, now) => {
      const a = {
        id: nextId(s, 'APP'),
        values: {},
        done: /** @type {number[]} */ ([]),
        status: 'draft',
        verifiedDoc: null,
        declaration: null,
      };
      s.applications.push(a);
      logEvent(s, 'started', { id: a.id }, now);
      return redirect(`/a/${a.id}/step/1`);
    },
  ],
  [
    'GET',
    '/a/:id/step/:n',
    (req, s, p) => {
      const a = find(s, p.id);
      const n = Number(p.n);
      if (!a || ![1, 2, 3, 4].includes(n)) return notFound();
      if (a.status === 'submitted') return redirect(`/a/${a.id}/done`);
      // a step is reached only once the ones before it are done
      if (n > nextStep(a)) return redirect(`/a/${a.id}/step/${nextStep(a)}`);
      return stepPage(s, a, n, req.url);
    },
  ],
  [
    'POST',
    '/a/:id/step/:n',
    (req, s, p, now) => {
      const a = find(s, p.id);
      const n = Number(p.n);
      if (!a || ![1, 2, 3, 4].includes(n)) return notFound();
      if (a.status === 'submitted') return redirect(`/a/${a.id}/done`);
      if (n > nextStep(a)) return redirect(`/a/${a.id}/step/${nextStep(a)}`);
      const { fields, files } = parseBody(req);
      if (n < 4) {
        const v = Object.fromEntries(FIELDS[/** @type {1|2|3} */ (n)].map((k) => [k, field(fields, k)]));
        const errors = stepErrors(s, n, v, a);
        logEvent(s, errors.length ? 'invalid' : 'step', { id: a.id, step: n, fields: errors.map(([f]) => f) }, now);
        // the entered values stay on the page with the errors
        if (errors.length) return { ...stepPage(s, a, n, req.url, errors, { ...a.values, ...v }), status: 422 };
        Object.assign(a.values, v);
        if (n === 2) a.verifiedDoc = verifiedDoc(s.secret, a.id, v.idToken);
        if (!a.done.includes(n)) a.done.push(n);
        return redirect(`/a/${a.id}/step/${n + 1}`);
      }
      const pdf = files.find((f) => f.field === 'declaration');
      if (pdf) {
        const head = Buffer.from(pdf.data, 'base64').subarray(0, 5).toString('latin1');
        if (head !== '%PDF-')
          return { ...stepPage(s, a, 4, req.url, [['declaration', 'The declaration must be a PDF file.']]), status: 422 };
        a.declaration = { name: pdf.name, type: pdf.type, size: pdf.size, data: pdf.data };
        logEvent(s, 'uploaded', { id: a.id, name: pdf.name, size: pdf.size }, now);
      }
      /** @type {[string, string][]} */
      const errors = [];
      if (!a.declaration) errors.push(['declaration', 'Upload the signed declaration.']);
      if (field(fields, 'agree') !== 'yes') errors.push(['agree', 'Confirm the details are correct.']);
      if (errors.length) return { ...stepPage(s, a, 4, req.url, errors), status: 422 };
      a.status = 'submitted';
      a.confirmation = `ONB-${createHmac('sha256', s.secret).update(a.id).digest('hex').slice(0, 8).toUpperCase()}`;
      a.submittedAt = new Date(now).toISOString();
      if (!a.done.includes(4)) a.done.push(4);
      logEvent(s, 'submitted', { id: a.id, confirmation: a.confirmation }, now);
      return redirect(withFlash(`/a/${a.id}/done`, 'Application submitted.'));
    },
  ],
  [
    'GET',
    '/a/:id/done',
    (req, s, p) => {
      const a = find(s, p.id);
      if (!a || a.status !== 'submitted') return notFound();
      return ok(
        page({
          app: `${s.company} ${TITLE}`,
          title: 'Submitted',
          flash: flashOf(req.url),
          body: html`<h1>Application ${a.id} submitted</h1><p>Confirmation number: <strong>${a.confirmation}</strong></p><p><a href="/a/${a.id}/signed.pdf">Download the signed copy (PDF)</a></p>`,
        }),
      );
    },
  ],
  [
    'GET',
    '/a/:id/signed.pdf',
    (_req, s, p, now) => {
      const a = find(s, p.id);
      if (!a || a.status !== 'submitted') return notFound();
      logEvent(s, 'downloaded', { id: a.id }, now);
      const doc = pdfDoc([
        `${s.company} onboarding: signed copy`,
        `Application ${a.id}`,
        `Name: ${a.values.name}`,
        `Department: ${a.values.department}`,
        `Start: ${a.values.start}`,
        `Confirmation: ${a.confirmation}`,
      ]);
      return bytes(`signed-${a.id}.pdf`, 'application/pdf', Buffer.from(doc, 'latin1').toString('base64'));
    },
  ],
];

/** @type {import('./server.mjs').App} */
export const onboard = {
  name: 'onboard',
  title: TITLE,
  init: initOnboard,
  handle(req, state, { now }) {
    const hit = route(req.method, req.url.pathname, ROUTES);
    return hit ? hit.handler(req, state, hit.params, now) : notFound();
  },
};

/** The identity-check provider's state: `{ secret }` (the wizard's), and every check it ran. @param {any} f */
export function initIdcheck(f) {
  if (typeof f?.secret !== 'string' || f.secret.length < 8) throw new Error('idcheck fixture needs the wizard secret');
  return { secret: f.secret, checks: /** @type {any[]} */ ([]), seq: 0, events: /** @type {any[]} */ ([]) };
}

/** The iframe page: a document form, or the verified result that posts the token to the wizard. @param {any} s @param {URL} url */
function verifyPage(s, url, error = '', verified = /** @type {any} */ (null)) {
  const app = url.searchParams.get('app') ?? '';
  const parent = url.origin.replace('://idcheck.', '://onboard.');
  const body = verified
    ? html`<p role="status">Document verified.</p><script>parent.postMessage({type:'idcheck',token:${raw(JSON.stringify(verified.token))},last4:${raw(JSON.stringify(verified.doc.slice(-4)))}},${raw(JSON.stringify(parent))});</script>`
    : html`<form method="post" action="/verify?app=${app}"><label for="doctype">Document type</label><select id="doctype" name="doctype"><option>Passport</option><option>National ID</option></select>
<label for="doc">Document number</label><input id="doc" name="doc"> <button>Verify</button></form>`;
  return ok(
    `<!doctype html><html><head><meta charset="utf-8"><title>Identity check</title></head><body style="font:14px system-ui">${error ? html`<p role="alert">${error}</p>`.__html : ''}${body.__html}</body></html>`,
  );
}

/** @type {import('./server.mjs').App} */
export const idcheck = {
  name: 'idcheck',
  title: 'Identity check',
  init: initIdcheck,
  handle(req, s, { now }) {
    if (req.url.pathname !== '/verify') return notFound();
    if (req.method === 'GET') return verifyPage(s, req.url);
    const app = req.url.searchParams.get('app') ?? '';
    const doc = field(parseBody(req).fields, 'doc').toUpperCase().replace(/\s+/g, '');
    const okDoc = validDocNumber(doc);
    s.checks.push({ app, doc, ok: okDoc, at: now });
    logEvent(s, okDoc ? 'verified' : 'rejected', { app, last4: doc.slice(-4) }, now);
    if (!okDoc) return { ...verifyPage(s, req.url, 'That document number is not valid. Check it and try again.'), status: 422 };
    return verifyPage(s, req.url, '', { doc, token: idToken(s.secret, app, doc) });
  },
};
