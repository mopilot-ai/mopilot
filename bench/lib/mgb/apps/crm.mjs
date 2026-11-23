// MoPilot 12-Grid Bench (#1381) CRM fixture (crm.localhost): accounts, contacts and deals with search, paging, stage
// filters, edit forms, deal notes and a confirmed contact delete; every change is in its state and event log for graders.
import { fmtMoney, parseMoney } from '../seed.mjs';
import { field, flashOf, html, logEvent, notFound, ok, page, paginate, parseBody, redirect, route, withFlash } from './kit.mjs';
import {
  applyChanges,
  assignIds,
  count,
  EMAIL,
  freshId,
  input,
  isDate,
  matches,
  param,
  records,
  rowsOr,
  searchForm,
  select,
} from './records.mjs';

export const STAGES = ['prospect', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];

/**
 * The CRM from a task's fixture: `{ user: { name, email }, accounts: [{ id?, name, industry?, tier?, owner? }],
 * contacts: [{ id?, name, email, phone?, title?, accountId }], deals: [{ id?, accountId, name, stage, amountCents,
 * closeDate, notes? }] }`.
 * @param {any} f
 */
export function init(f) {
  const email = String(f?.user?.email ?? '')
    .trim()
    .toLowerCase();
  if (!EMAIL.test(email)) throw new Error('crm fixture needs user.email');
  const accounts = records(f, 'accounts', 'crm');
  const contacts = records(f, 'contacts', 'crm');
  const deals = records(f, 'deals', 'crm');
  const state = {
    user: { name: String(f.user.name ?? email), email },
    accounts: /** @type {any[]} */ ([]),
    contacts: /** @type {any[]} */ ([]),
    deals: /** @type {any[]} */ ([]),
    seq: 0,
    events: /** @type {any[]} */ ([]),
  };
  const accIds = assignIds(state, 'ACC', accounts, 'id');
  accounts.forEach((a, i) => {
    const name = String(a.name ?? '').trim();
    if (!name) throw new Error(`account ${accIds[i]} needs a name`);
    state.accounts.push({
      id: accIds[i],
      name,
      industry: String(a.industry ?? ''),
      tier: String(a.tier ?? ''),
      owner: String(a.owner ?? ''),
    });
  });
  const conIds = assignIds(state, 'CON', contacts, 'id');
  contacts.forEach((c, i) => {
    const d = {
      name: String(c.name ?? ''),
      email: String(c.email ?? ''),
      phone: String(c.phone ?? ''),
      title: String(c.title ?? ''),
      accountId: String(c.accountId),
    };
    const error = contactError(state, d);
    if (error) throw new Error(`contact ${conIds[i]}: ${error}`);
    state.contacts.push({ id: conIds[i], ...d, email: d.email.toLowerCase() });
  });
  const dealIds = assignIds(state, 'DEAL', deals, 'id');
  deals.forEach((d, i) => {
    const id = dealIds[i];
    if (!account(state, d.accountId)) throw new Error(`deal ${id} names unknown account ${d.accountId}`);
    if (!STAGES.includes(d.stage)) throw new Error(`deal ${id} has unknown stage ${d.stage}`);
    if (!Number.isInteger(d.amountCents)) throw new Error(`deal ${id} needs amountCents as an integer`);
    if (!isDate(d.closeDate)) throw new Error(`deal ${id} needs closeDate as YYYY-MM-DD`);
    const notes = (d.notes ?? []).map(String);
    state.deals.push({
      id,
      accountId: String(d.accountId),
      name: String(d.name ?? id),
      stage: d.stage,
      amountCents: d.amountCents,
      closeDate: d.closeDate,
      notes,
    });
  });
  return state;
}

const TITLE = 'CRM';
/** @type {[string, string][]} */
const NAV = [
  ['/accounts', 'Accounts'],
  ['/contacts', 'Contacts'],
  ['/deals', 'Deals'],
  ['/contacts/new', 'New contact'],
  ['/deals/new', 'New deal'],
];
const view = (/** @type {URL} */ url, /** @type {string} */ title, /** @type {unknown} */ body, error = '') =>
  ok(page({ app: TITLE, title, nav: NAV, flash: flashOf(url), error, body }));
const invalid = (/** @type {import('./kit.mjs').Res} */ res) => ({ ...res, status: 422 });
const account = (/** @type {any} */ s, /** @type {unknown} */ id) => s.accounts.find((/** @type {any} */ a) => a.id === String(id));
const contact = (/** @type {any} */ s, /** @type {string} */ id) => s.contacts.find((/** @type {any} */ c) => c.id === id);
const deal = (/** @type {any} */ s, /** @type {string} */ id) => s.deals.find((/** @type {any} */ d) => d.id === id);
const byName = (/** @type {any} */ a, /** @type {any} */ b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
const byClose = (/** @type {any} */ a, /** @type {any} */ b) => a.closeDate.localeCompare(b.closeDate) || a.id.localeCompare(b.id);
const accountOptions = (/** @type {any} */ s) =>
  /** @type {[string, string][]} */ ([
    ['', 'Choose an account'],
    ...[...s.accounts].sort(byName).map((/** @type {any} */ a) => [a.id, a.name]),
  ]);

/** @param {any} s @param {any[]} list */
const contactRows = (s, list) =>
  list.map(
    (/** @type {any} */ c) =>
      html`<tr><td><a href="/contacts/${c.id}">${c.name}</a></td><td>${c.title}</td><td>${c.email}</td><td>${c.phone}</td><td>${account(s, c.accountId).name}</td></tr>`,
  );
/** @param {any} s @param {any[]} list */
const dealRows = (s, list) =>
  list.map(
    (/** @type {any} */ d) =>
      html`<tr><td><a href="/deals/${d.id}">${d.name}</a></td><td>${account(s, d.accountId).name}</td><td>${d.stage}</td><td>${fmtMoney(d.amountCents)}</td><td>${d.closeDate}</td></tr>`,
  );
const CONTACT_HEAD = html`<thead><tr><th>Name</th><th>Title</th><th>Email</th><th>Phone</th><th>Account</th></tr></thead>`;
const DEAL_HEAD = html`<thead><tr><th>Deal</th><th>Account</th><th>Stage</th><th>Amount</th><th>Close date</th></tr></thead>`;

/** @typedef {{ name: string, email: string, phone: string, title: string, accountId: string }} ContactDraft */
/** @param {Record<string, string[]>} fields @returns {ContactDraft} */
const contactDraft = (fields) => ({
  name: field(fields, 'name'),
  email: field(fields, 'email'),
  phone: field(fields, 'phone'),
  title: field(fields, 'title'),
  accountId: field(fields, 'accountId'),
});
/** What is wrong with a contact, or ''. @param {any} s @param {ContactDraft} d */
function contactError(s, d) {
  if (!d.name.trim()) return 'Name is required.';
  if (!EMAIL.test(d.email)) return `Not an email address: ${d.email}`;
  if (!account(s, d.accountId)) return 'Choose an existing account.';
  return '';
}
/** @param {any} s @param {string} action @param {ContactDraft} d @param {string} button */
const contactForm = (s, action, d, button) =>
  html`<form method="post" action="${action}">${input('Name', 'name', d.name)}${input('Email', 'email', d.email, 'email')}${input('Phone', 'phone', d.phone)}${input('Title', 'title', d.title)}${select('Account', 'accountId', accountOptions(s), d.accountId)}<p><button>${button}</button></p></form>`;

/** @typedef {{ name: string, accountId: string, stage: string, amount: string, closeDate: string }} DealDraft */
/** @param {Record<string, string[]>} fields @returns {DealDraft} */
const dealDraft = (fields) => ({
  name: field(fields, 'name'),
  accountId: field(fields, 'accountId'),
  stage: field(fields, 'stage'),
  amount: field(fields, 'amount'),
  closeDate: field(fields, 'closeDate'),
});
/** What is wrong with a deal, or ''. @param {any} s @param {DealDraft} d */
function dealError(s, d) {
  if (!d.name) return 'Name is required.';
  if (!account(s, d.accountId)) return 'Choose an existing account.';
  if (!STAGES.includes(d.stage)) return `Choose a stage: ${STAGES.join(', ')}.`;
  if (parseMoney(d.amount) === null) return `Not an amount: ${d.amount}`;
  if (!isDate(d.closeDate)) return 'Close date must be a date written YYYY-MM-DD.';
  return '';
}
/** The record a valid deal draft becomes. @param {DealDraft} d */
const dealValues = (d) => ({
  name: d.name,
  accountId: d.accountId,
  stage: d.stage,
  amountCents: parseMoney(d.amount),
  closeDate: d.closeDate,
});
/** @param {any} s @param {string} action @param {DealDraft} d @param {string} button */
const dealForm = (s, action, d, button) =>
  html`<form method="post" action="${action}">${input('Name', 'name', d.name)}${select('Account', 'accountId', accountOptions(s), d.accountId)}${select('Stage', 'stage', STAGES, d.stage)}${input('Amount', 'amount', d.amount)}${input('Close date', 'closeDate', d.closeDate, 'date')}<p><button>${button}</button></p></form>`;

/** @param {URL} url @param {any} s @param {any} c @param {ContactDraft} d */
const contactPage = (url, s, c, d, error = '') =>
  view(
    url,
    c.name,
    html`<div class="card"><h1>${c.name}</h1><p>${c.title}<br>${c.email}<br>${c.phone}<br>Account: <a href="/accounts/${c.accountId}">${account(s, c.accountId).name}</a></p></div>
<h2>Edit contact</h2>${contactForm(s, `/contacts/${c.id}`, d, 'Save contact')}<p><a href="/contacts/${c.id}/delete">Delete contact</a></p>`,
    error,
  );

/** @param {URL} url @param {any} s @param {any} d @param {DealDraft} draft */
const dealPage = (url, s, d, draft, note = '', error = '') =>
  view(
    url,
    d.name,
    html`<div class="card"><h1>${d.name}</h1><p>Account: <a href="/accounts/${d.accountId}">${account(s, d.accountId).name}</a><br>Stage: ${d.stage}<br>Amount: ${fmtMoney(d.amountCents)}<br>Close date: ${d.closeDate}</p></div>
<h2>Notes</h2>${d.notes.length ? html`<ul>${d.notes.map((/** @type {string} */ n) => html`<li>${n}</li>`)}</ul>` : html`<p class="muted">No notes yet.</p>`}
<form method="post" action="/deals/${d.id}/notes"><label for="note">Add note</label><textarea id="note" name="note">${note}</textarea><p><button>Add note</button></p></form>
<h2>Edit deal</h2>${dealForm(s, `/deals/${d.id}`, draft, 'Save deal')}`,
    error,
  );

/** The deal's current values as a form draft. @param {any} d @returns {DealDraft} */
const draftOf = (d) => ({ name: d.name, accountId: d.accountId, stage: d.stage, amount: fmtMoney(d.amountCents), closeDate: d.closeDate });

/** @type {[string, string, (req: any, s: any, p: Record<string, string>, now: number) => any][]} */
const ROUTES = [
  ['GET', '/', () => redirect('/accounts')],
  [
    'GET',
    '/accounts',
    (req, s) => {
      const q = param(req.url, 'q');
      const all = s.accounts.filter((/** @type {any} */ a) => matches(q, [a.name, a.industry, a.owner])).sort(byName);
      const { items, pager } = paginate(all, req.url);
      const rows = items.map(
        (/** @type {any} */ a) =>
          html`<tr><td><a href="/accounts/${a.id}">${a.name}</a></td><td>${a.industry}</td><td>${a.tier}</td><td>${a.owner}</td></tr>`,
      );
      return view(
        req.url,
        'Accounts',
        html`<h1>Accounts</h1>${searchForm(q, 'Search accounts')}<p class="muted">${count(all.length, 'account')}</p>
<table><thead><tr><th>Name</th><th>Industry</th><th>Tier</th><th>Owner</th></tr></thead><tbody>${rowsOr(rows, 4)}</tbody></table>${pager}`,
      );
    },
  ],
  [
    'GET',
    '/accounts/:id',
    (req, s, p) => {
      const a = account(s, p.id);
      if (!a) return notFound('No such account');
      const contacts = s.contacts.filter((/** @type {any} */ c) => c.accountId === a.id).sort(byName);
      const deals = s.deals.filter((/** @type {any} */ d) => d.accountId === a.id).sort(byClose);
      return view(
        req.url,
        a.name,
        html`<div class="card"><h1>${a.name}</h1><p>Industry: ${a.industry}<br>Tier: ${a.tier}<br>Owner: ${a.owner}</p></div>
<h2>Contacts</h2><table>${CONTACT_HEAD}<tbody>${rowsOr(contactRows(s, contacts), 5)}</tbody></table>
<h2>Deals</h2><table>${DEAL_HEAD}<tbody>${rowsOr(dealRows(s, deals), 5)}</tbody></table>`,
      );
    },
  ],
  [
    'GET',
    '/contacts',
    (req, s) => {
      const q = param(req.url, 'q');
      const all = s.contacts.filter((/** @type {any} */ c) => matches(q, [c.name, c.email, account(s, c.accountId).name])).sort(byName);
      const { items, pager } = paginate(all, req.url);
      return view(
        req.url,
        'Contacts',
        html`<h1>Contacts</h1>${searchForm(q, 'Search contacts')}<p class="muted">${count(all.length, 'contact')}</p>
<table>${CONTACT_HEAD}<tbody>${rowsOr(contactRows(s, items), 5)}</tbody></table>${pager}`,
      );
    },
  ],
  ['GET', '/contacts/new', (req, s) => newContact(req.url, s, contactDraft({ accountId: [param(req.url, 'accountId')] }))],
  [
    'POST',
    '/contacts',
    (req, s, _p, now) => {
      const d = contactDraft(parseBody(req).fields);
      const error = contactError(s, d);
      if (error) return invalid(newContact(req.url, s, d, error));
      const id = freshId(s, 'CON', (i) => !!contact(s, i));
      s.contacts.push({ id, ...d, email: d.email.toLowerCase() });
      logEvent(s, 'created', { kind: 'contact', id, name: d.name, email: d.email.toLowerCase(), accountId: d.accountId }, now);
      return redirect(withFlash(`/contacts/${id}`, 'Contact created.'));
    },
  ],
  [
    'GET',
    '/contacts/:id',
    (req, s, p) => {
      const c = contact(s, p.id);
      return c ? contactPage(req.url, s, c, c) : notFound('No such contact');
    },
  ],
  [
    'POST',
    '/contacts/:id',
    (req, s, p, now) => {
      const c = contact(s, p.id);
      if (!c) return notFound('No such contact');
      const d = contactDraft(parseBody(req).fields);
      const error = contactError(s, d);
      if (error) return invalid(contactPage(req.url, s, c, d, error));
      const changes = applyChanges(c, { ...d, email: d.email.toLowerCase() }, ['name', 'email', 'phone', 'title', 'accountId']);
      return updated(s, 'contact', c.id, changes, now, `/contacts/${c.id}`);
    },
  ],
  [
    'GET',
    '/contacts/:id/delete',
    (req, s, p) => {
      const c = contact(s, p.id);
      if (!c) return notFound('No such contact');
      return view(
        req.url,
        `Delete ${c.name}`,
        html`<div class="card"><h1>Delete ${c.name}?</h1><p>Delete ${c.name} (${c.email})? This cannot be undone.</p>
<form method="post" action="/contacts/${c.id}/delete"><button>Delete contact</button></form> <a href="/contacts/${c.id}">Cancel</a></div>`,
      );
    },
  ],
  [
    'POST',
    '/contacts/:id/delete',
    (_req, s, p, now) => {
      const c = contact(s, p.id);
      if (!c) return notFound('No such contact');
      s.contacts.splice(s.contacts.indexOf(c), 1);
      logEvent(s, 'deleted', { kind: 'contact', id: c.id, name: c.name, email: c.email }, now);
      return redirect(withFlash('/contacts', `Deleted ${c.name}.`));
    },
  ],
  [
    'GET',
    '/deals',
    (req, s) => {
      const q = param(req.url, 'q');
      const stage = param(req.url, 'stage');
      const all = s.deals
        .filter((/** @type {any} */ d) => (!stage || d.stage === stage) && matches(q, [d.name, account(s, d.accountId).name]))
        .sort(byClose);
      const { items, pager } = paginate(all, req.url);
      const filter = select('Stage', 'stage', [['', 'All stages'], ...STAGES], stage);
      return view(
        req.url,
        'Deals',
        html`<h1>Deals</h1>${searchForm(q, 'Search deals', filter)}<p class="muted">${count(all.length, 'deal')}</p>
<table>${DEAL_HEAD}<tbody>${rowsOr(dealRows(s, items), 5)}</tbody></table>${pager}`,
      );
    },
  ],
  [
    'GET',
    '/deals/new',
    (req, s) => newDeal(req.url, s, { name: '', accountId: param(req.url, 'accountId'), stage: 'prospect', amount: '', closeDate: '' }),
  ],
  [
    'POST',
    '/deals',
    (req, s, _p, now) => {
      const d = dealDraft(parseBody(req).fields);
      const error = dealError(s, d);
      if (error) return invalid(newDeal(req.url, s, d, error));
      const id = freshId(s, 'DEAL', (i) => !!deal(s, i));
      const values = dealValues(d);
      s.deals.push({ id, ...values, notes: [] });
      logEvent(s, 'created', { kind: 'deal', id, ...values }, now);
      return redirect(withFlash(`/deals/${id}`, 'Deal created.'));
    },
  ],
  [
    'GET',
    '/deals/:id',
    (req, s, p) => {
      const d = deal(s, p.id);
      return d ? dealPage(req.url, s, d, draftOf(d)) : notFound('No such deal');
    },
  ],
  [
    'POST',
    '/deals/:id',
    (req, s, p, now) => {
      const d = deal(s, p.id);
      if (!d) return notFound('No such deal');
      const draft = dealDraft(parseBody(req).fields);
      const error = dealError(s, draft);
      if (error) return invalid(dealPage(req.url, s, d, draft, '', error));
      const changes = applyChanges(d, dealValues(draft), ['name', 'accountId', 'stage', 'amountCents', 'closeDate']);
      if (changes.stage) logEvent(s, 'stageChanged', { id: d.id, from: changes.stage.from, to: changes.stage.to }, now);
      return updated(s, 'deal', d.id, changes, now, `/deals/${d.id}`);
    },
  ],
  [
    'POST',
    '/deals/:id/notes',
    (req, s, p, now) => {
      const d = deal(s, p.id);
      if (!d) return notFound('No such deal');
      const note = (parseBody(req).fields.note?.[0] ?? '').trim();
      if (!note) return invalid(dealPage(req.url, s, d, draftOf(d), note, 'Write a note first.'));
      d.notes.push(note);
      logEvent(s, 'noteAdded', { id: d.id, note }, now);
      return redirect(withFlash(`/deals/${d.id}`, 'Note added.'));
    },
  ],
];

/** Logs an update (when anything changed) and returns to the record. @param {any} s @param {string} kind @param {string} id */
function updated(s, kind, id, /** @type {Record<string, any>} */ changes, /** @type {number} */ now, /** @type {string} */ to) {
  const fields = Object.keys(changes);
  if (fields.length) logEvent(s, 'updated', { kind, id, fields, changes }, now);
  return redirect(withFlash(to, fields.length ? `Saved ${kind}.` : 'No changes.'));
}

/** @param {URL} url @param {any} s @param {ContactDraft} d */
const newContact = (url, s, d, error = '') =>
  view(url, 'New contact', html`<h1>New contact</h1>${contactForm(s, '/contacts', d, 'Create contact')}`, error);
/** @param {URL} url @param {any} s @param {DealDraft} d */
const newDeal = (url, s, d, error = '') => view(url, 'New deal', html`<h1>New deal</h1>${dealForm(s, '/deals', d, 'Create deal')}`, error);

/** @type {import('./server.mjs').App} */
export const crm = {
  name: 'crm',
  title: TITLE,
  init,
  handle(req, state, { now }) {
    const hit = route(req.method, req.url.pathname, ROUTES);
    return hit ? hit.handler(req, state, hit.params, now) : notFound();
  },
};
