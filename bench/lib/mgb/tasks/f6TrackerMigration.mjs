// MGB task f6-tracker-migration (#1381, F6): ten meeting action items filed as tracker issues (assignee and labels
// by the page's rules) with CRM deal notes for customer items; items 1-5 before the chat switches harness, 6-10 after,
// then the migration checklist closed with every key. Graded on each issue existing once and nothing redone or lost.
import { has } from '../grade.mjs';
import { dayOffset, distinct, people } from '../seed.mjs';
import { at, eventsOf, longDay, mentionsId, slug } from './common.mjs';
import { browse } from './drive.mjs';
import { confirmedId, ORD } from './f6Common.mjs';

/** Items filed before the switch: 1 to 5. */
export const FIRST = 5;
const AREAS = ['Billing', 'Mobile', 'Web', 'Data'];
const VERBS = ['Fix', 'Update', 'Document', 'Review', 'Automate', 'Clean up', 'Migrate', 'Audit'];
const OBJECTS = [
  'the invoice export',
  'the login timeout',
  'the push notification copy',
  'the nightly backup job',
  'the pricing page banner',
  'the refund webhook',
  'the search index rebuild',
  'the onboarding emails',
  'the tax rate table',
  'the crash reporter',
  'the CSV importer',
  'the dark mode colors',
];

/** The page's line for an item. @param {any} it @param {number} n */
const itemLine = (it, n) =>
  `- ${n}. [${it.area}] ${it.base}${it.customer ? ` for ${it.customer.name}` : ''}${it.named ? ` (${it.named} will own this)` : ''}`;
/** The issues filed for an item: titled with its text. @param {any} state @param {any} it @returns {any[]} */
export const issuesFor = (state, it) => state.tracker.issues.filter((/** @type {any} */ i) => has(i.title, it.base));
/** The items that name a customer, in page order. @param {any} d @returns {any[]} */
export const customerItems = (d) => d.items.filter((/** @type {any} */ it) => it.customer);
/** The checklist issue. @param {any} state @param {any} d */
const checklist = (state, d) => state.tracker.issues.find((/** @type {any} */ i) => i.key === d.checklistKey);
/** Whether two label lists hold the same labels. @param {string[]} a @param {string[]} b */
const sameLabels = (a, b) => a.length === b.length && b.every((l) => a.includes(l));
/** The notes on an item's customer's open deal that give one of the item's issue keys. @param {any} state @param {any} it */
const notesFor = (state, it) => {
  const keys = issuesFor(state, it).map((i) => i.key);
  const deal = state.crm.deals.find((/** @type {any} */ x) => x.id === it.customer.openDeal);
  return deal.notes.filter((/** @type {string} */ n) => keys.some((k) => mentionsId(n, k)));
};

/**
 * Files items the way the page says: an issue each, then a note on the customer's open deal with its key. The oracle
 * runs it per half; tests run it for wrong agents. Returns the keys it made, in item order.
 * @param {any} d @param {any} state @param {any[]} items
 */
export function file(d, state, items) {
  const tracker = browse(state, 'tracker');
  const crm = browse(state, 'crm');
  const keys = [];
  for (const it of items) {
    const res = tracker.post('/issues', {
      title: it.base,
      body: `Action item from meeting ${d.code}.${it.customer ? ` Customer: ${it.customer.name}.` : ''}`,
      priority: 'medium',
      assignee: it.assignee,
      labels: it.labels,
    });
    const key = confirmedId(res, /Created ([A-Z]+-\d+)/);
    keys.push(key);
    if (it.customer) crm.post(`/deals/${it.customer.openDeal}/notes`, { note: `Tracked as ${key} (${it.base}).` });
  }
  return keys;
}

/** Closes the checklist with a comment that lists keys. @param {any} d @param {any} state @param {string[]} keys */
export function closeChecklist(d, state, keys) {
  const tracker = browse(state, 'tracker');
  tracker.post(`/issues/${d.checklistKey}/comments`, { comment: `All action items filed: ${keys.join(', ')}.` });
  tracker.post(`/issues/${d.checklistKey}/status`, { status: 'done' });
}

/** @type {import('../schema.mjs').Task} */
export const task = {
  id: 'f6-tracker-migration',
  family: 'F6',
  title: 'File ten meeting action items as issues with CRM notes across a harness switch, then close the checklist',
  surfaces: ['iab'],
  columns: ['switch'],
  tier: 'full',
  apps: ['docs', 'tracker', 'crm'],
  actions: [40, 80],
  cards: 0,
  switchBefore: 2,
  data(r, env) {
    const [company, ...names] = distinct(r.company, 7);
    const [user, ...crew] = people(r, 6, `${slug(company)}.test`);
    const owners = Object.fromEntries(AREAS.map((a, i) => [a, crew[i].name]));
    const code = r.token('MTG', 5);
    const oldCode = r.token('MTG', 5);
    const meeting = dayOffset(env.today, -r.int(1, 3));
    const customers = names.map((name, i) => ({
      name,
      account: `ACC-${10 + i}`,
      openDeal: `DEAL-${30 + i * 2}`,
      closedDeal: `DEAL-${31 + i * 2}`,
    }));
    // two customer items and one item with a named owner in each half
    const withCustomer = [...r.sample([0, 1, 2, 3, 4], 2), ...r.sample([5, 6, 7, 8, 9], 2)];
    const withOwner = [r.pick([0, 1, 2, 3, 4]), r.pick([5, 6, 7, 8, 9])];
    const picked = r.sample(customers, 4);
    const items = distinct(() => `${r.pick(VERBS)} ${r.pick(OBJECTS)}`, 10).map((base, n) => {
      const area = r.pick(AREAS);
      const customer = withCustomer.includes(n) ? picked[withCustomer.indexOf(n)] : null;
      // someone other than the area's owner, who the item names
      const named = withOwner.includes(n) ? r.pick(crew.filter((c) => c.name !== owners[area])).name : null;
      return {
        n: n + 1,
        base,
        area,
        customer,
        named,
        assignee: named ?? owners[area],
        labels: [area.toLowerCase(), ...(customer ? ['customer'] : [])],
      };
    });
    return {
      company,
      user,
      crew,
      owners,
      code,
      oldCode,
      meeting,
      customers,
      items,
      checklistKey: `OPS-${r.int(20, 49)}`,
      oldChecklistKey: `OPS-${r.int(50, 79)}`,
    };
  },
  fixtures(d, env) {
    const page = `Ops sync notes, ${longDay(d.meeting)}`;
    return {
      docs: {
        user: { name: d.user.name },
        spaces: [{ key: 'OPS', name: 'Operations' }],
        pages: [
          {
            space: 'OPS',
            title: page,
            author: d.crew[0].name,
            updatedAt: at(d.meeting, 16),
            body: [
              `# Ops sync, ${longDay(d.meeting)}`,
              `Meeting code: ${d.code}`,
              '# Action items',
              ...d.items.map((/** @type {any} */ it) => itemLine(it, it.n)),
              '# Filing rules',
              '- One tracker issue per action item, titled with the item text (without the customer and owner notes).',
              `- Assign it to the area's owner: ${Object.entries(d.owners)
                .map(([a, o]) => `${a}: ${o}`)
                .join('; ')}. When the item names someone who will own it, assign it to that person instead.`,
              '- Labels: the area in lower case (billing, mobile, web or data), plus customer when the item is for a customer.',
              `- Put the meeting code ${d.code} in each issue's description.`,
              "- For an item that is for a customer, add a note to that customer's open deal in the CRM giving the issue key.",
              `- When every item has its issue, close the migration checklist issue ${d.checklistKey} with a comment listing all the issue keys.`,
            ].join('\n'),
          },
          {
            space: 'OPS',
            title: `Ops sync notes, ${longDay(dayOffset(d.meeting, -14))}`,
            author: d.crew[1].name,
            updatedAt: at(dayOffset(d.meeting, -14), 16),
            body: `# Ops sync\nMeeting code: ${d.oldCode}\n# Action items\n- 1. [Web] Fix the status page footer\nAll filed; checklist ${d.oldChecklistKey} closed.`,
          },
        ],
      },
      tracker: {
        user: { name: d.user.name },
        project: { key: 'OPS', name: 'Operations' },
        members: [d.user.name, ...d.crew.map((/** @type {any} */ c) => c.name)],
        labels: ['billing', 'mobile', 'web', 'data', 'customer', 'bug'],
        issues: [
          {
            key: d.oldChecklistKey,
            title: `Migration checklist: ops sync ${dayOffset(d.meeting, -14)}`,
            body: `Move the action items of meeting ${d.oldCode} into the tracker.`,
            status: 'done',
            assignee: d.user.name,
          },
          {
            key: d.checklistKey,
            title: `Migration checklist: ops sync ${d.meeting}`,
            body: 'Move the action items of the latest ops sync into the tracker, then close this issue.',
            assignee: d.user.name,
          },
          { key: `OPS-${80 + d.items[0].n}`, title: 'Fix the status page footer', body: `From meeting ${d.oldCode}.`, status: 'done' },
          { key: `OPS-${90 + d.items[1].n}`, title: 'Rotate the staging certificates', priority: 'high', labels: ['bug'] },
        ],
      },
      crm: {
        user: { name: d.user.name, email: d.user.email },
        accounts: d.customers.map((/** @type {any} */ c) => ({ id: c.account, name: c.name, owner: d.user.name })),
        contacts: [],
        deals: d.customers.flatMap((/** @type {any} */ c) => [
          {
            id: c.openDeal,
            accountId: c.account,
            name: `${c.name} renewal`,
            stage: 'negotiation',
            amountCents: 1200000,
            closeDate: dayOffset(env.today, 30),
            notes: ['Renewal call booked.'],
          },
          {
            id: c.closedDeal,
            accountId: c.account,
            name: `${c.name} pilot`,
            stage: 'won',
            amountCents: 300000,
            closeDate: dayOffset(env.today, -200),
          },
        ]),
      },
    };
  },
  prompt(d, env) {
    const page = `Ops sync notes, ${longDay(d.meeting)}`;
    return [
      `I'm ${d.user.name} at ${d.company}. Use the in-app browser. The notes from our last ops sync are on the "${page}" page in our wiki (${env.urls.docs}): ten action items and the rules for filing them. Create an issue in our tracker (${env.urls.tracker}) for each of items 1 to 5, with the assignee, labels and description the page's rules give.`,
      `Thanks. Now, for those of items 1 to 5 that are for a customer, add the note the page asks for in our CRM (${env.urls.crm}).`,
      'Now continue with items 6 to 10: create their issues the same way, and add the CRM notes for the ones that are for a customer.',
      'Finally, close the migration checklist issue the page names, with a comment that lists the keys of all ten issues.',
    ];
  },
  secrets: (d) => [d.code, ...d.items.map((/** @type {any} */ it) => it.base)],
  checkpoints: [
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => ({
      id: `issue-${k + 1}`,
      title: `Item ${k + 1} has exactly one issue, assigned and labelled by the page's rules`,
      check: (/** @type {any} */ { data, state }) => {
        const it = data.items[k];
        const list = issuesFor(state, it);
        return list.length === 1 && list[0].assignee === it.assignee && sameLabels(list[0].labels, it.labels);
      },
    })),
    ...[0, 1, 2, 3].map((k) => ({
      id: `note-${k}`,
      title: `The ${ORD[k]} customer item has exactly one note with its issue key, on the customer's open deal`,
      check: (/** @type {any} */ { data, state }) => notesFor(state, customerItems(data)[k]).length === 1,
    })),
    {
      id: 'no-stray-issue',
      title: 'Every new issue is one of the action items',
      weight: 0.5,
      check: ({ data, state }) =>
        eventsOf(state.tracker, 'created').every((/** @type {any} */ e) =>
          data.items.some((/** @type {any} */ it) => has(e.title, it.base)),
        ),
    },
    {
      id: 'checklist-closed',
      title: 'The migration checklist issue is closed',
      check: ({ data, state }) => checklist(state, data).status === 'done',
    },
    {
      id: 'checklist-keys',
      title: 'A comment on the checklist lists an existing issue key for every one of the ten items',
      check: ({ data, state }) =>
        checklist(state, data).comments.some((/** @type {any} */ c) =>
          data.items.every((/** @type {any} */ it) => issuesFor(state, it).some((i) => mentionsId(c.body, i.key))),
        ),
    },
    {
      id: 'meeting-code',
      title: 'Every item has an issue, and every issue gives the meeting code',
      canary: true,
      check: ({ data, state }) =>
        data.items.every((/** @type {any} */ it) => {
          const list = issuesFor(state, it);
          return list.length > 0 && list.every((i) => has(i.body, data.code));
        }),
    },
  ],
  solve(d, state) {
    const keys = [...file(d, state, d.items.slice(0, FIRST)), ...file(d, state, d.items.slice(FIRST))];
    closeChecklist(d, state, keys);
    return state;
  },
};
