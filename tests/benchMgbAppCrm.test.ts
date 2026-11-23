// bench/lib/mgb/apps crm.mjs and records.mjs (#1381): the CRM fixture app's journeys (accounts, contacts, deals, notes,
// confirmed delete), validation that keeps what was typed, paging, filters, 404s and fixture checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { form, req, text } from './support/mgb-app-kit.ts';

const { crm, init, STAGES } = await import('../bench/lib/mgb/apps/crm.mjs');
const { assignIds, isDate, records } = await import('../bench/lib/mgb/apps/records.mjs');

const NOW = Date.parse('2026-03-02T10:00:00Z');

function fixture(): any {
  const accounts = [
    { id: 'ACC-1', name: 'Bluefin Labs', industry: 'Biotech', tier: 'Gold', owner: 'Rowan Pike' },
    { name: 'Copperleaf Foods' },
    ...Array.from({ length: 10 }, (_, i) => ({ name: `Zeta Holdings ${String(i).padStart(2, '0')}`, industry: 'Retail' })),
  ];
  return {
    user: { name: 'Avery Quill', email: 'Avery@Example.test' },
    accounts,
    contacts: [
      { id: 'CON-7', name: 'Mira Sol', email: 'mira@bluefin.test', phone: '555-0101', title: 'CTO', accountId: 'ACC-1' },
      { name: 'Theo Grant', email: 'THEO@copperleaf.test', accountId: 'ACC-2' },
    ],
    deals: [
      {
        id: 'DEAL-1',
        accountId: 'ACC-1',
        name: 'Bluefin renewal',
        stage: 'proposal',
        amountCents: 123450,
        closeDate: '2026-04-30',
        notes: ['Kickoff went well'],
      },
      { accountId: 'ACC-2', stage: 'prospect', amountCents: 5000, closeDate: '2026-05-15' },
    ],
  };
}

const app = (fx = fixture()) => {
  const state = crm.init(fx);
  const call = (method: string, path: string, body?: Record<string, string | string[]>) =>
    crm.handle(req(method, path, { app: 'crm', ...(body ? form(body) : {}) }), state, { now: NOW });
  return { state, call };
};

test('init: ids default to ACC-n, CON-n, DEAL-n around given ones; emails lowercase; defaults filled', () => {
  const s = init(fixture());
  assert.equal(crm.name, 'crm');
  assert.equal(crm.title, 'CRM');
  assert.deepEqual(s.user, { name: 'Avery Quill', email: 'avery@example.test' });
  assert.deepEqual(
    s.accounts.slice(0, 2).map((a: any) => a.id),
    ['ACC-1', 'ACC-2'],
  );
  assert.deepEqual(s.accounts[1], { id: 'ACC-2', name: 'Copperleaf Foods', industry: '', tier: '', owner: '' });
  assert.deepEqual(
    s.contacts.map((c: any) => [c.id, c.email, c.phone, c.title]),
    [
      ['CON-7', 'mira@bluefin.test', '555-0101', 'CTO'],
      ['CON-13', 'theo@copperleaf.test', '', ''],
    ],
  );
  assert.deepEqual(s.deals[1], {
    id: 'DEAL-14',
    accountId: 'ACC-2',
    name: 'DEAL-14',
    stage: 'prospect',
    amountCents: 5000,
    closeDate: '2026-05-15',
    notes: [],
  });
  assert.deepEqual(s.events, []);
  assert.equal(init({ user: { email: 'a@b.test' }, accounts: [], contacts: [], deals: [] }).user.name, 'a@b.test');
  assert.deepEqual(STAGES, ['prospect', 'qualified', 'proposal', 'negotiation', 'won', 'lost']);
});

test('init rejects bad fixtures with a clear error', () => {
  const bad = (patch: (f: any) => void, re: RegExp) => {
    const f: any = fixture();
    patch(f);
    assert.throws(() => init(f), re);
  };
  assert.throws(() => init(null), /needs user.email/);
  assert.throws(() => init({}), /needs user.email/);
  bad((f) => (f.user.email = 'nope'), /needs user.email/);
  bad((f) => delete f.accounts, /accounts list of objects/);
  bad((f) => (f.contacts = [null]), /contacts list of objects/);
  bad((f) => (f.deals = 'x'), /deals list of objects/);
  bad((f) => (f.accounts[1].name = '  '), /account ACC-2 needs a name/);
  bad((f) => delete f.accounts[1].name, /account ACC-2 needs a name/);
  bad((f) => (f.accounts[1].id = 'ACC-1'), /duplicate id in the fixture: ACC-1/);
  bad((f) => delete f.contacts[0].name, /contact CON-7: Name is required/);
  bad((f) => delete f.contacts[0].email, /contact CON-7: Not an email address/);
  bad((f) => (f.contacts[0].accountId = 'ACC-404'), /contact CON-7: Choose an existing account/);
  bad((f) => (f.deals[0].accountId = 'ACC-404'), /deal DEAL-1 names unknown account ACC-404/);
  bad((f) => (f.deals[0].stage = 'closed'), /deal DEAL-1 has unknown stage closed/);
  bad((f) => (f.deals[0].amountCents = 12.5), /amountCents as an integer/);
  bad((f) => (f.deals[0].closeDate = '2026-02-30'), /closeDate as YYYY-MM-DD/);
});

test('records helpers: list check, ids and calendar days', () => {
  assert.throws(() => records({ x: [1] }, 'x', 'app'), /app fixture needs a x list of objects/);
  assert.throws(() => records(undefined, 'x', 'app'), /needs a x list/);
  const state = { seq: 0 };
  assert.deepEqual(assignIds(state, 'K', [{ id: 'K-2' }, {}, { id: 'K-1' }, {}], 'id'), ['K-2', 'K-3', 'K-1', 'K-4']);
  for (const d of ['2026-02-28', '2024-02-29']) assert.equal(isDate(d), true, d);
  for (const d of ['2026-02-29', '2026-13-01', '2026-1-01', '', 20260101, null]) assert.equal(isDate(d), false, String(d));
});

test('accounts: list, search, paging and detail with contacts and deals', () => {
  const { call } = app();
  assert.equal(call('GET', '/').headers.location, '/accounts');
  const first = call('GET', '/accounts');
  assert.equal(first.status, 200);
  assert.match(text(first), /12 accounts/);
  assert.match(text(first), /Page 1 of 2/);
  assert.match(text(first), /Bluefin Labs Biotech Gold Rowan Pike/);
  assert.doesNotMatch(text(first), /Zeta Holdings 09/);
  assert.match(text(call('GET', '/accounts?page=2')), /Zeta Holdings 09/);
  const search = call('GET', '/accounts?q=rowan');
  assert.match(text(search), /1 account\b/);
  assert.match(search.body, /value="rowan"/);
  assert.match(text(call('GET', '/accounts?q=nothing-matches')), /0 accounts Name Industry Tier Owner Nothing here\./);
  const detail = text(call('GET', '/accounts/ACC-1'));
  assert.match(detail, /Bluefin Labs Industry: Biotech Tier: Gold Owner: Rowan Pike/);
  assert.match(detail, /Mira Sol CTO mira@bluefin\.test 555-0101 Bluefin Labs/);
  assert.match(detail, /Bluefin renewal Bluefin Labs proposal \$1,234\.50 2026-04-30/);
  assert.match(text(call('GET', '/accounts/ACC-3')), /Contacts Name .* Nothing here\. Deals .* Nothing here\./);
  assert.equal(call('GET', '/accounts/ACC-404').status, 404);
  assert.equal(call('GET', '/nowhere').status, 404);
});

test('contacts: search by name, email and company, sorted, paged', () => {
  const fx = fixture();
  for (let i = 0; i < 10; i++) fx.contacts.push({ name: `Zed Contact ${i}`, email: `zed${i}@zeta.test`, accountId: 'ACC-3' });
  const { call } = app(fx);
  const list = text(call('GET', '/contacts'));
  assert.match(list, /12 contacts/);
  assert.match(list, /Mira Sol .* Theo Grant/);
  assert.match(list, /Page 1 of 2/);
  assert.match(text(call('GET', '/contacts?q=copperleaf')), /1 contact .*Theo Grant/);
  assert.match(text(call('GET', '/contacts?q=MIRA@')), /1 contact .*Mira Sol/);
  assert.match(text(call('GET', '/contacts?q=Copperleaf+Foods')), /Theo Grant/);
});

test('contact journey: open, edit, the change and its old/new values are logged', () => {
  const { state, call } = app();
  const page = call('GET', '/contacts/CON-7');
  assert.match(text(page), /Mira Sol CTO mira@bluefin\.test 555-0101 Account: Bluefin Labs/);
  assert.match(page.body, /<option value="ACC-1" selected>Bluefin Labs<\/option>/);
  const saved = call('POST', '/contacts/CON-7', {
    name: 'Mira Sol',
    email: 'Mira.Sol@Bluefin.test',
    phone: '555-0199',
    title: 'CTO',
    accountId: 'ACC-1',
  });
  assert.equal(saved.status, 303);
  assert.equal(saved.headers.location, '/contacts/CON-7?flash=Saved%20contact.');
  assert.match(text(call('GET', saved.headers.location)), /Saved contact\..*mira\.sol@bluefin\.test 555-0199/);
  assert.deepEqual(state.events, [
    {
      at: NOW,
      type: 'updated',
      kind: 'contact',
      id: 'CON-7',
      fields: ['email', 'phone'],
      changes: { email: { from: 'mira@bluefin.test', to: 'mira.sol@bluefin.test' }, phone: { from: '555-0101', to: '555-0199' } },
    },
  ]);
  const same = call('POST', '/contacts/CON-7', {
    name: 'Mira Sol',
    email: 'mira.sol@bluefin.test',
    phone: '555-0199',
    title: 'CTO',
    accountId: 'ACC-1',
  });
  assert.equal(same.headers.location, '/contacts/CON-7?flash=No%20changes.');
  assert.equal(state.events.length, 1);
});

test('contact edit: invalid input answers 422, keeps what was typed and changes nothing', () => {
  const { state, call } = app();
  const before = structuredClone(state.contacts);
  const cases: [Record<string, string>, RegExp][] = [
    [{ name: '', email: 'x@y.test', accountId: 'ACC-1' }, /Name is required\./],
    [{ name: 'Mira Typed', email: 'not-an-email', accountId: 'ACC-1' }, /Not an email address: not-an-email/],
    [{ name: 'Mira Typed', email: 'x@y.test', accountId: 'ACC-404' }, /Choose an existing account\./],
  ];
  for (const [body, re] of cases) {
    const res = call('POST', '/contacts/CON-7', body);
    assert.equal(res.status, 422);
    assert.match(res.body, /<div class="error" role="alert">/);
    assert.match(text(res), re);
    assert.match(res.body, new RegExp(`value="${body.email}"`));
  }
  assert.match(call('POST', '/contacts/CON-7', cases[1][0]).body, /id="name" name="name" type="text" value="Mira Typed"/);
  assert.deepEqual(state.contacts, before);
  assert.deepEqual(state.events, []);
  assert.equal(call('POST', '/contacts/CON-404', cases[0][0]).status, 404);
  assert.equal(call('GET', '/contacts/CON-404').status, 404);
});

test('new contact: prefilled account, validation keeps input, then created and logged', () => {
  const { state, call } = app();
  const blank = call('GET', '/contacts/new?accountId=ACC-2');
  assert.match(blank.body, /<option value="ACC-2" selected>Copperleaf Foods<\/option>/);
  assert.match(blank.body, /<option value="" >Choose an account<\/option>|<option value="">Choose an account<\/option>/);
  const bad = call('POST', '/contacts', { name: 'Ines Park', email: 'ines@', phone: '555-0177', title: 'Buyer', accountId: 'ACC-2' });
  assert.equal(bad.status, 422);
  assert.match(bad.body, /value="Ines Park"/);
  assert.match(bad.body, /value="555-0177"/);
  assert.match(bad.body, /value="Buyer"/);
  assert.equal(state.contacts.length, 2);
  const res = call('POST', '/contacts', {
    name: 'Ines Park',
    email: 'Ines@Copperleaf.test',
    phone: '555-0177',
    title: 'Buyer',
    accountId: 'ACC-2',
  });
  assert.equal(res.status, 303);
  const id = state.contacts[2].id;
  assert.equal(id, 'CON-15');
  assert.equal(res.headers.location, `/contacts/${id}?flash=Contact%20created.`);
  assert.deepEqual(state.contacts[2], {
    id,
    name: 'Ines Park',
    email: 'ines@copperleaf.test',
    phone: '555-0177',
    title: 'Buyer',
    accountId: 'ACC-2',
  });
  assert.deepEqual(state.events, [
    { at: NOW, type: 'created', kind: 'contact', id, name: 'Ines Park', email: 'ines@copperleaf.test', accountId: 'ACC-2' },
  ]);
  assert.match(text(call('GET', '/accounts/ACC-2')), /Ines Park Buyer/);
});

test('delete contact goes through a confirmation page; the POST deletes and logs it', () => {
  const { state, call } = app();
  assert.match(call('GET', '/contacts/CON-7').body, /href="\/contacts\/CON-7\/delete"/);
  const confirm = call('GET', '/contacts/CON-7/delete');
  assert.equal(confirm.status, 200);
  assert.match(text(confirm), /Delete Mira Sol \(mira@bluefin\.test\)\? This cannot be undone\. Delete contact Cancel/);
  assert.match(confirm.body, /<form method="post" action="\/contacts\/CON-7\/delete">/);
  assert.equal(state.contacts.length, 2, 'viewing the confirmation deletes nothing');
  const res = call('POST', '/contacts/CON-7/delete');
  assert.equal(res.headers.location, '/contacts?flash=Deleted%20Mira%20Sol.');
  assert.deepEqual(
    state.contacts.map((c: any) => c.id),
    ['CON-13'],
  );
  assert.deepEqual(state.events, [
    { at: NOW, type: 'deleted', kind: 'contact', id: 'CON-7', name: 'Mira Sol', email: 'mira@bluefin.test' },
  ]);
  assert.match(text(call('GET', res.headers.location)), /Deleted Mira Sol\. .*1 contact\b/);
  assert.equal(call('GET', '/contacts/CON-7/delete').status, 404);
  assert.equal(call('POST', '/contacts/CON-7/delete').status, 404);
});

test('deals: stage filter, search, paging, money and close-date order', () => {
  const fx = fixture();
  for (let i = 0; i < 10; i++)
    fx.deals.push({ accountId: 'ACC-3', name: `Zeta pilot ${i}`, stage: 'qualified', amountCents: 100000 + i, closeDate: `2026-06-1${i}` });
  const { call } = app(fx);
  const all = call('GET', '/deals');
  assert.match(text(all), /12 deals .*Page 1 of 2/);
  assert.match(
    text(all),
    /Bluefin renewal Bluefin Labs proposal \$1,234\.50 2026-04-30 DEAL-14 Copperleaf Foods prospect \$50\.00 2026-05-15/,
  );
  assert.match(all.body, /<option value="" selected>All stages<\/option>/);
  const qualified = call('GET', '/deals?stage=qualified&page=2');
  assert.match(text(qualified), /10 deals/);
  assert.match(qualified.body, /<option value="qualified" selected>/);
  assert.match(text(call('GET', '/deals?q=copperleaf')), /1 deal .*DEAL-14/);
  assert.match(text(call('GET', '/deals?q=renewal&stage=won')), /0 deals .*Nothing here\./);
  assert.match(text(call('GET', '/deals?stage=proposal')), /1 deal .*Bluefin renewal/);
});

test('deal journey: edit stage, amount and date; updated and stageChanged logged; notes added', () => {
  const { state, call } = app();
  const page = call('GET', '/deals/DEAL-1');
  assert.match(
    text(page),
    /Bluefin renewal Account: Bluefin Labs Stage: proposal Amount: \$1,234\.50 Close date: 2026-04-30 Notes Kickoff went well/,
  );
  assert.match(page.body, /id="amount" name="amount" type="text" value="\$1,234\.50"/);
  assert.match(text(call('GET', '/deals/DEAL-14')), /No notes yet\./);
  const res = call('POST', '/deals/DEAL-1', {
    name: 'Bluefin renewal',
    accountId: 'ACC-1',
    stage: 'won',
    amount: '1,500',
    closeDate: '2026-04-28',
  });
  assert.equal(res.headers.location, '/deals/DEAL-1?flash=Saved%20deal.');
  assert.deepEqual([state.deals[0].stage, state.deals[0].amountCents, state.deals[0].closeDate], ['won', 150000, '2026-04-28']);
  assert.deepEqual(state.events, [
    { at: NOW, type: 'stageChanged', id: 'DEAL-1', from: 'proposal', to: 'won' },
    {
      at: NOW,
      type: 'updated',
      kind: 'deal',
      id: 'DEAL-1',
      fields: ['stage', 'amountCents', 'closeDate'],
      changes: {
        stage: { from: 'proposal', to: 'won' },
        amountCents: { from: 123450, to: 150000 },
        closeDate: { from: '2026-04-30', to: '2026-04-28' },
      },
    },
  ]);
  const amountOnly = call('POST', '/deals/DEAL-1', {
    name: 'Bluefin renewal',
    accountId: 'ACC-1',
    stage: 'won',
    amount: '$1,600.00',
    closeDate: '2026-04-28',
  });
  assert.equal(amountOnly.status, 303);
  assert.deepEqual(state.events.at(-1).fields, ['amountCents']);
  assert.equal(state.events.filter((e: any) => e.type === 'stageChanged').length, 1);
  const note = call('POST', '/deals/DEAL-1/notes', { note: '  Signed by legal  ' });
  assert.equal(note.headers.location, '/deals/DEAL-1?flash=Note%20added.');
  assert.deepEqual(state.deals[0].notes, ['Kickoff went well', 'Signed by legal']);
  assert.deepEqual(state.events.at(-1), { at: NOW, type: 'noteAdded', id: 'DEAL-1', note: 'Signed by legal' });
  assert.match(text(call('GET', note.headers.location)), /Note added\..*Kickoff went well Signed by legal/);
});

test('deal validation: 422 keeps input; empty notes refused; unknown deals 404', () => {
  const { state, call } = app();
  const before = structuredClone(state.deals);
  const good = { name: 'Bluefin renewal', accountId: 'ACC-1', stage: 'won', amount: '99', closeDate: '2026-04-30' };
  const cases: [Record<string, string>, RegExp][] = [
    [{ ...good, name: '' }, /Name is required\./],
    [{ ...good, accountId: 'ACC-404' }, /Choose an existing account\./],
    [{ ...good, stage: 'closed' }, /Choose a stage: prospect, qualified, proposal, negotiation, won, lost\./],
    [{ ...good, amount: '12,34' }, /Not an amount: 12,34/],
    [{ ...good, closeDate: '30/04/2026' }, /Close date must be a date written YYYY-MM-DD\./],
  ];
  for (const [body, re] of cases) {
    const res = call('POST', '/deals/DEAL-1', body);
    assert.equal(res.status, 422);
    assert.match(text(res), re);
    assert.match(res.body, new RegExp(`value="${body.amount}"`));
    assert.match(res.body, new RegExp(`value="${body.closeDate.replaceAll('/', '\\/')}"`));
  }
  const empty = call('POST', '/deals/DEAL-1/notes', { note: '   ' });
  assert.equal(empty.status, 422);
  assert.match(text(empty), /Write a note first\./);
  assert.equal(call('POST', '/deals/DEAL-1/notes', {}).status, 422);
  assert.deepEqual(state.deals, before);
  assert.deepEqual(state.events, []);
  assert.equal(call('GET', '/deals/DEAL-404').status, 404);
  assert.equal(call('POST', '/deals/DEAL-404', good).status, 404);
  assert.equal(call('POST', '/deals/DEAL-404/notes', { note: 'x' }).status, 404);
});

test('new deal: defaults, validation keeps input, created with parsed amount and logged', () => {
  const { state, call } = app();
  const blank = call('GET', '/deals/new?accountId=ACC-1');
  assert.match(blank.body, /<option value="ACC-1" selected>/);
  assert.match(blank.body, /<option value="prospect" selected>prospect<\/option>/);
  const draft = { name: 'Copperleaf expansion', accountId: 'ACC-2', stage: 'negotiation', amount: 'lots', closeDate: '2026-07-01' };
  const bad = call('POST', '/deals', draft);
  assert.equal(bad.status, 422);
  assert.match(bad.body, /value="Copperleaf expansion"/);
  assert.match(bad.body, /value="lots"/);
  assert.match(bad.body, /<option value="negotiation" selected>/);
  assert.equal(state.deals.length, 2);
  const res = call('POST', '/deals', { ...draft, amount: 'USD 2,500.75' });
  const created = state.deals[2];
  assert.equal(res.headers.location, `/deals/${created.id}?flash=Deal%20created.`);
  assert.deepEqual(created, {
    id: 'DEAL-15',
    name: 'Copperleaf expansion',
    accountId: 'ACC-2',
    stage: 'negotiation',
    amountCents: 250075,
    closeDate: '2026-07-01',
    notes: [],
  });
  assert.deepEqual(state.events, [
    {
      at: NOW,
      type: 'created',
      kind: 'deal',
      id: 'DEAL-15',
      name: 'Copperleaf expansion',
      accountId: 'ACC-2',
      stage: 'negotiation',
      amountCents: 250075,
      closeDate: '2026-07-01',
    },
  ]);
  assert.match(text(call('GET', '/deals?stage=negotiation')), /Copperleaf expansion Copperleaf Foods negotiation \$2,500\.75 2026-07-01/);
});

test('ids of new records skip ones the fixture already uses', () => {
  const fx = fixture();
  fx.contacts.push({ id: 'CON-15', name: 'Taken Id', email: 'taken@zeta.test', accountId: 'ACC-3' });
  fx.deals.push({ id: 'DEAL-17', accountId: 'ACC-3', name: 'Taken deal', stage: 'lost', amountCents: 0, closeDate: '2026-01-01' });
  const { state, call } = app(fx);
  call('POST', '/contacts', { name: 'Next One', email: 'next@zeta.test', accountId: 'ACC-3' });
  assert.equal(state.contacts.at(-1).id, 'CON-16');
  call('POST', '/deals', { name: 'Next deal', accountId: 'ACC-3', stage: 'won', amount: '1', closeDate: '2026-01-02' });
  assert.equal(state.deals.at(-1).id, 'DEAL-18');
});

test('records with the same name or close date are listed in id order', () => {
  const fx = fixture();
  fx.accounts.push({ id: 'ACC-0', name: 'Bluefin Labs' } as any);
  fx.deals.push({ id: 'DEAL-0', accountId: 'ACC-1', name: 'Same day', stage: 'won', amountCents: 1, closeDate: '2026-04-30' });
  const { call } = app(fx);
  assert.match(call('GET', '/accounts').body, /accounts\/ACC-0"[\s\S]*accounts\/ACC-1"/);
  assert.match(call('GET', '/deals').body, /deals\/DEAL-0"[\s\S]*deals\/DEAL-1"/);
});
