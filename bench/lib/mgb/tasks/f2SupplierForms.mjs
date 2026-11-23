// MGB task f2-supplier-forms (#1381, F2): read two supplier registration PDFs from the wiki on the Mac, onboard the
// first-time supplier in the CRM and the Legal tracker, note the duplicate on its open deal, and file both forms.
import { exactlyOnce, has, same } from '../grade.mjs';
import { dayOffset, distinct, people } from '../seed.mjs';
import { at } from './common.mjs';
import { browse } from './drive.mjs';
import { bodyBytes, digits, fileAt, pdfBase64, putFile, sha256Of } from './f2Common.mjs';

const TERMS = ['Net 30', 'Net 45', 'Net 60', '2/10 net 30'];
const ROLES = ['Accounts receivable lead', 'Sales manager', 'Finance director', 'Key account manager'];
const STREETS = ['Quay Street', 'Foundry Row', 'Canal Wharf', 'Market Square', 'Ropewalk'];
export const PAGE = 'New suppliers';

/** @param {string} s */
const slug = (s) => s.toLowerCase().replace(/[^a-z]+/g, '');
/** The lines a registration form shows. @param {any} f */
export const formLines = (f) => [
  'Supplier registration form',
  `Company: ${f.company}`,
  `Address: ${f.address}`,
  `Contact name: ${f.contact.name}`,
  `Contact title: ${f.title}`,
  `Email: ${f.email}`,
  `Phone: ${f.phone}`,
  `Tax ID: ${f.taxId}`,
  `Payment terms: ${f.terms}`,
];
/** Where a form is filed on the Mac. @param {any} f */
export const filedAs = (f) => `suppliers/${f.company}.pdf`;
/** The Legal issues titled for a company. @param {any} state @param {string} company */
const legalIssues = (state, company) => state.tracker.issues.filter((/** @type {any} */ i) => same(i.title, `Legal review: ${company}`));
/** The issue for the first-time supplier, when there is exactly one. @param {any} d @param {any} state */
const legalIssue = (d, state) => {
  const list = legalIssues(state, d.fresh.company);
  return list.length === 1 ? list[0] : null;
};
/** The contacts on an account. @param {any} state @param {string} accountId */
const contactsOn = (state, accountId) => state.crm.contacts.filter((/** @type {any} */ c) => c.accountId === accountId);
/** Whether a filed form is the downloaded one, byte for byte. @param {any} state @param {any} f */
const filed = (state, f) => fileAt(state.files, filedAs(f))?.sha256 === sha256Of(f.base64);

/** @type {import('../schema.mjs').Task} */
export const task = {
  id: 'f2-supplier-forms',
  family: 'F2',
  title: 'Process supplier registration PDFs into the CRM and the Legal tracker, and file them',
  surfaces: ['iab', 'cu'],
  tier: 'full',
  apps: ['docs', 'crm', 'tracker'],
  actions: [30, 75],
  cards: 0,
  data(r, env) {
    const [buyer, freshCo, dupCo, ...others] = distinct(r.company, 7);
    const [user, lawyer, keeper, ...contacts] = people(r, 9, `${slug(buyer)}.test`);
    const form = (/** @type {string} */ company, /** @type {any} */ contact) => {
      const f = {
        company,
        contact,
        title: r.pick(ROLES),
        email: `${contact.first}.${contact.last}@${slug(company)}.test`.toLowerCase(),
        phone: `+44 20 ${r.int(1000, 9999)} ${r.int(1000, 9999)}`,
        address: `${r.int(1, 99)} ${r.pick(STREETS)}, ${r.city()}`,
        taxId: `TX-${r.int(10000000, 99999999)}`,
        terms: r.pick(TERMS),
      };
      return { ...f, base64: pdfBase64(formLines(f)) };
    };
    const fresh = form(freshCo, contacts[0]);
    const dup = form(dupCo, contacts[1]);
    return {
      buyer,
      user,
      lawyer,
      keeper,
      others,
      people: contacts.slice(2),
      fresh,
      dup,
      // the attachment names say nothing about the company: the forms must be opened
      order: r.shuffle(['fresh', 'dup']),
      openDeal: { name: `${dupCo} supply agreement ${env.today.slice(0, 4)}`, amountCents: r.int(80, 400) * 1000 },
      noteBefore: `Kick-off call held with ${keeper.name}.`,
    };
  },
  fixtures(d, env) {
    const accounts = [
      { id: 'ACC-11', name: d.dup.company, industry: 'Supplier', tier: 'Active', owner: d.user.name },
      { id: 'ACC-12', name: d.fresh.company, industry: 'Supplier', tier: 'Pending', owner: '' },
      ...d.others.map((/** @type {string} */ name, /** @type {number} */ i) => ({
        id: `ACC-${20 + i}`,
        name,
        industry: i % 2 ? 'Customer' : 'Supplier',
        tier: 'Active',
        owner: d.user.name,
      })),
    ];
    const contacts = [
      {
        name: d.keeper.name,
        email: `${d.keeper.first}@${slug(d.dup.company)}.test`.toLowerCase(),
        title: 'Account manager',
        accountId: 'ACC-11',
      },
      ...d.people.map((/** @type {any} */ p, /** @type {number} */ i) => ({
        name: p.name,
        email: `${p.first}@${slug(d.others[i])}.test`.toLowerCase(),
        title: 'Buyer',
        accountId: `ACC-${20 + i}`,
      })),
    ];
    const deals = [
      {
        id: 'DEAL-31',
        accountId: 'ACC-11',
        name: d.openDeal.name,
        stage: 'negotiation',
        amountCents: d.openDeal.amountCents,
        closeDate: dayOffset(env.today, 40),
        notes: [d.noteBefore],
      },
      {
        id: 'DEAL-32',
        accountId: 'ACC-11',
        name: `${d.dup.company} pilot order`,
        stage: 'won',
        amountCents: 1200000,
        closeDate: dayOffset(env.today, -200),
      },
      {
        id: 'DEAL-33',
        accountId: 'ACC-20',
        name: `${d.others[0]} renewal`,
        stage: 'proposal',
        amountCents: 5400000,
        closeDate: dayOffset(env.today, 20),
      },
    ];
    const forms = d.order.map((/** @type {string} */ k, /** @type {number} */ i) => ({
      name: `supplier-registration-${i + 1}.pdf`,
      type: 'application/pdf',
      base64: d[k].base64,
    }));
    return {
      docs: {
        user: { name: d.user.name },
        spaces: [
          { key: 'PROC', name: 'Procurement' },
          { key: 'TEAM', name: 'Team' },
        ],
        pages: [
          {
            space: 'PROC',
            title: PAGE,
            author: d.lawyer.name,
            updatedAt: at(dayOffset(env.today, -1), 9),
            body: [
              '# New suppliers',
              'Two registration forms came in this week; they are attached below.',
              'Intake opens a pending CRM account for every first-time supplier. One of these two companies is already an active supplier of ours, so its form is a duplicate.',
              '## How to process a registration',
              '- First-time supplier: add the contact on the form to its pending CRM account, with exactly the values on the form (name, title, email, phone).',
              '- Then open an issue in the Legal tracker titled "Legal review: <company>", attach the registration form, and give the tax ID and payment terms in the description.',
              '- Duplicate: do not create anything. Add a note to the company’s open deal saying a duplicate registration came in, with the tax ID from the form.',
            ].join('\n'),
            attachments: forms,
          },
          {
            space: 'PROC',
            title: 'Supplier payment terms',
            body: 'Standard terms are net 30. Anything shorter needs finance approval.',
            updatedAt: at(dayOffset(env.today, -30), 10),
          },
          {
            space: 'TEAM',
            title: 'Office move',
            body: 'We move to the third floor next month.',
            updatedAt: at(dayOffset(env.today, -5), 15),
          },
        ],
      },
      crm: { user: { name: d.user.name, email: d.user.email }, accounts, contacts, deals },
      tracker: {
        user: { name: d.user.name },
        project: { key: 'LEG', name: 'Legal' },
        members: [d.user.name, d.lawyer.name],
        labels: ['legal', 'supplier', 'contract'],
        issues: [
          { title: `Legal review: ${d.others[1]}`, body: 'Done last quarter.', status: 'done', labels: ['legal', 'supplier'] },
          { title: 'Update the NDA template', body: 'Use the 2026 clause set.', status: 'todo', assignee: d.lawyer.name },
        ],
      },
      files: { entries: {} },
    };
  },
  prompt(d, env) {
    return [
      `I'm ${d.user.name} in procurement at ${d.buyer}. Two supplier registration forms are attached to the "${PAGE}" page in our docs (${env.urls.docs}). Use the in-app browser for the websites and the Mac's apps (Finder, Preview) for files. Download both forms, open them on the Mac and read them, then look each company up in our CRM (${env.urls.crm}). Tell me what each form says and which company we already work with; don't change anything yet.`,
      `Now process both registrations the way the "${PAGE}" page describes, in the CRM and the Legal tracker (${env.urls.tracker}), uploading the forms you downloaded where an attachment is needed. Then save both forms in a "suppliers" folder inside ${env.files}, each named after its company, like "Example Company.pdf".`,
    ];
  },
  secrets: (d) => [d.fresh.taxId, d.dup.taxId, d.fresh.email, d.fresh.phone, d.fresh.contact.name],
  checkpoints: [
    {
      id: 'contact-new',
      title: 'One contact was added to the first-time supplier’s pending account',
      check: ({ state }) => contactsOn(state, 'ACC-12').length === 1,
    },
    {
      id: 'contact-values',
      title: 'The contact has exactly the form’s name, title, email and phone',
      check: ({ data, state }) => {
        const f = data.fresh;
        return contactsOn(state, 'ACC-12').some(
          (/** @type {any} */ c) =>
            digits(c.phone) === digits(f.phone) &&
            [
              [c.name, f.contact.name],
              [c.title, f.title],
              [c.email, f.email],
            ].every(([x, y]) => same(x, y)),
        );
      },
    },
    {
      id: 'legal-issue',
      title: 'One Legal review issue for the first-time supplier',
      check: ({ data, state }) => !!legalIssue(data, state),
    },
    {
      id: 'legal-pdf',
      title: 'The Legal review issue has the registration form attached',
      check: ({ data, state }) =>
        !!legalIssue(data, state)?.attachments.some((/** @type {any} */ a) => sha256Of(a.data) === sha256Of(data.fresh.base64)),
    },
    {
      id: 'legal-tax-id',
      title: 'The Legal review issue gives the tax ID from the form',
      canary: true,
      check: ({ data, state }) => has(legalIssue(data, state)?.body, data.fresh.taxId),
    },
    {
      id: 'dup-note',
      title: 'The duplicate’s open deal has a note with the tax ID from its form',
      check: ({ data, state }) =>
        exactlyOnce(state.crm.deals.find((/** @type {any} */ x) => x.id === 'DEAL-31').notes, (/** @type {string} */ n) =>
          has(n, data.dup.taxId),
        ),
    },
    {
      id: 'no-duplicate',
      title: 'Nothing was created for the duplicate and its closed deal was left alone',
      weight: 0.5,
      check: ({ data, state }) =>
        contactsOn(state, 'ACC-11').length === 1 &&
        state.crm.deals.filter((/** @type {any} */ x) => x.accountId === 'ACC-11').length === 2 &&
        state.crm.deals.find((/** @type {any} */ x) => x.id === 'DEAL-32').notes.length === 0 &&
        legalIssues(state, data.dup.company).length === 0,
    },
    {
      id: 'file-fresh',
      title: 'The first-time supplier’s form is filed under its company name',
      check: ({ data, state }) => filed(state, data.fresh),
    },
    { id: 'file-dup', title: 'The duplicate’s form is filed under its company name', check: ({ data, state }) => filed(state, data.dup) },
  ],
  solve(d, state) {
    const docs = browse(state, 'docs');
    const page = state.docs.pages.find((/** @type {any} */ p) => p.title === PAGE);
    /** @type {Record<string, Buffer>} */
    const pdfs = {};
    d.order.forEach((/** @type {string} */ k, /** @type {number} */ i) => {
      pdfs[k] = bodyBytes(docs.get(`/p/${page.id}/att/${i}`));
      putFile(state, filedAs(d[k]), pdfs[k]);
    });
    const f = d.fresh;
    browse(state, 'crm').post('/contacts', { name: f.contact.name, title: f.title, email: f.email, phone: f.phone, accountId: 'ACC-12' });
    browse(state, 'tracker').post('/issues', {
      fields: {
        title: `Legal review: ${f.company}`,
        body: `Tax ID: ${f.taxId}\nPayment terms: ${f.terms}`,
        priority: 'medium',
        labels: 'legal',
      },
      files: [{ field: 'attach', name: `${f.company}.pdf`, type: 'application/pdf', content: pdfs.fresh }],
    });
    browse(state, 'crm').post('/deals/DEAL-31/notes', { note: `Duplicate supplier registration received (tax ID ${d.dup.taxId}).` });
    return state;
  },
};
