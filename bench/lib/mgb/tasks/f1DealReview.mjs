// MGB task f1-deal-review (#1381, F1): apply last Friday's pipeline-review minutes from the wiki to six of fifteen CRM
// deals (stage, amounts in words or relative to the CRM, computed close dates, a note with the meeting code) and open a
// legal-review issue, assigned to whoever covers legal now, for each deal the minutes flag.
import { has } from '../grade.mjs';
import { dayOffset, distinct, fmtMoney, people } from '../seed.mjs';
import { at, eventsOf, longDay, mondayOf, slug } from './common.mjs';
import { browse } from './drive.mjs';

const ORD = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
/** Pairs of deal topics close enough that a careless search updates the wrong deal. */
const TOPICS = [
  ['platform renewal', 'platform expansion'],
  ['analytics pilot', 'analytics rollout'],
  ['support renewal', 'support upgrade'],
  ['fleet licences', 'fleet add-on'],
  ['data migration', 'data archive'],
  ['training package', 'training refresh'],
  ['security review', 'security add-on'],
  ['api access', 'api overage'],
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
/** 21-99 in words: "forty-two". @param {number} n */
const inWords = (n) => [TENS[Math.floor(n / 10)], ONES[n % 10]].filter(Boolean).join('-');
/** Whole dollars as written in notes: "$48,500". @param {number} cents */
const dollars = (cents) => `$${(cents / 100).toLocaleString('en-US')}`;
const NOTES = [
  'Customer wants a two-year term.',
  'Procurement signs off next week.',
  'Champion moved teams; re-confirm the sponsor.',
  'Pricing agreed in principle.',
  'Asked for a security questionnaire.',
  'Budget confirmed for Q1.',
];

/** The last weekday of the month after `day`'s month. @param {string} day YYYY-MM-DD */
export function lastBusinessDayOfNextMonth(day) {
  const [y, m] = day.split('-').map(Number);
  // day 0 of the month after next is the last day of next month
  const last = new Date(Date.UTC(y, m + 1, 0, 12)).toISOString().slice(0, 10);
  const dow = new Date(`${last}T12:00:00Z`).getUTCDay();
  return dayOffset(last, -[2, 0, 0, 0, 0, 0, 1][dow]);
}

/** How the minutes give a deal's new amount, from the amount in the CRM. */
const AMOUNT = {
  digits: (/** @type {any} */ r) => {
    const cents = r.int(24, 190) * 50000;
    return { cents, text: `Amount: ${dollars(cents)}` };
  },
  words: (/** @type {any} */ r) => {
    const n = r.int(21, 99);
    return { cents: n * 100000, text: `Amount: ${inWords(n)} thousand dollars` };
  },
  up: (/** @type {any} */ r, /** @type {number} */ cur) => {
    const p = r.pick([10, 15, 20, 25]);
    return { cents: cur + (cur * p) / 100, text: `Amount: up ${p}% on what the CRM has now` };
  },
  down: (/** @type {any} */ r, /** @type {number} */ cur) => {
    const p = r.pick([10, 20]);
    return { cents: cur - (cur * p) / 100, text: `Amount: cut ${p}% from the current CRM amount` };
  },
};

/** The deal with a name, as the CRM has it now (throws when the agent renamed or deleted it). @param {any} state @param {string} name */
const dealOf = (state, name) => {
  const d = state.crm.deals.find((/** @type {any} */ x) => x.name === name);
  if (!d) throw new Error(`no deal named ${name}`);
  return d;
};
/** Legal issues for a deal. @param {any} state @param {any} t */
const legalIssues = (state, t) => state.tracker.issues.filter((/** @type {any} */ i) => has(i.title, t.name));

/** @type {import('../schema.mjs').Task} */
export const task = {
  id: 'f1-deal-review',
  family: 'F1',
  title: 'Apply pipeline-review minutes to CRM deals and open legal reviews',
  surfaces: ['iab'],
  tier: 'full',
  apps: ['docs', 'crm', 'tracker'],
  actions: [40, 80],
  cards: 0,
  switchBefore: 1,
  data(r, env) {
    const [seller, ...accounts] = distinct(r.company, 10);
    const [user, legal, away, rep] = people(r, 4, `${slug(seller)}.test`);
    const pairs = r.sample(TOPICS, 8);
    const amountKinds = r.shuffle(['digits', 'words', 'words', 'up', 'up', 'down']);
    const closeKinds = r.shuffle([true, true, true, false, false, false]);
    const monthEnd = lastBusinessDayOfNextMonth(env.today);
    const targets = amountKinds.map((kind, k) => {
      const [topic, sibling] = r.shuffle(pairs[k]);
      const stage = r.pick(['qualified', 'proposal', 'negotiation']);
      // never a round thousand or half thousand: a new amount in words or digits always changes it
      const amountCents = (r.int(12, 94) * 1000 + r.pick([100, 200, 300, 400, 600, 700, 800, 900])) * 100;
      const amount = AMOUNT[/** @type {keyof typeof AMOUNT} */ (kind)](r, amountCents);
      const close = closeKinds[k] ? monthEnd : dayOffset(env.today, r.int(20, 80));
      return {
        name: `${accounts[k]} ${topic}`,
        sibling: `${accounts[k]} ${sibling}`,
        account: k,
        stage,
        amountCents,
        // sooner than any new close date (20+ days out, or next month's end)
        closeDate: dayOffset(env.today, r.int(3, 15)),
        newStage: r.pick(['proposal', 'negotiation', 'won', 'lost'].filter((s) => s !== stage)),
        newCents: amount.cents,
        amountText: amount.text,
        newClose: close,
        closeText: closeKinds[k] ? 'Close: push to the last business day of next month' : `Close: move to ${longDay(close)}`,
        note: r.pick(NOTES),
      };
    });
    /** @param {string} name @param {number} account */
    const plain = (name, account) => ({
      name,
      account,
      stage: r.pick(['prospect', 'qualified', 'proposal', 'negotiation']),
      amountCents: r.int(50, 900) * 10000,
      closeDate: dayOffset(env.today, r.int(5, 90)),
    });
    // three reviewed deals have a sibling with a similar name on the same account; six more deals sit on other accounts
    const others = [
      ...targets.slice(0, 3).map((t) => plain(t.sibling, t.account)),
      ...[0, 1, 2, 3, 4, 5].map((i) => plain(`${accounts[6 + (i % 3)]} ${pairs[6 + (i % 2)][i % 2]}`, 6 + (i % 3))),
    ];
    const legalDeals = r.sample([0, 1, 2, 3, 4, 5], 2).sort();
    return {
      seller,
      accounts,
      user,
      legal,
      away,
      rep,
      targets,
      others,
      legalDeals,
      code: r.token('MTG', 4),
      oldCode: r.token('MTG', 4),
      review: dayOffset(mondayOf(env.today), -3),
    };
  },
  fixtures(d, env) {
    const deals = [...d.targets, ...d.others].map((x) => ({
      accountId: `ACC-${x.account + 1}`,
      name: x.name,
      stage: x.stage,
      amountCents: x.amountCents,
      closeDate: x.closeDate,
      notes: [],
    }));
    const section = (/** @type {any} */ t, /** @type {number} */ k) =>
      [
        `## ${t.name}`,
        `- Stage: ${t.newStage}`,
        `- ${t.amountText}`,
        `- ${t.closeText}`,
        `- Note to add: "${d.code} ${t.note}"`,
        ...(d.legalDeals.includes(k) ? ['- Needs legal review before we send paper.'] : []),
      ].join('\n');
    const old = d.targets.slice(0, 2);
    return {
      docs: {
        user: { name: d.user.name },
        spaces: [{ key: 'SALES', name: 'Sales' }],
        pages: [
          {
            space: 'SALES',
            title: `Pipeline review — ${d.review}`,
            author: d.rep.name,
            updatedAt: at(d.review, 17),
            body: `# Pipeline review — ${d.review}\nAttendees: ${d.user.name}, ${d.rep.name}, ${d.legal.name}.\nMeeting code ${d.code}: start every CRM note from this review with it.\nLegal: ${d.away.name} is on leave this month; ${d.legal.name} is covering all contract reviews until they're back.\n${d.targets.map(section).join('\n')}\n## Everything else\n- No changes.`,
          },
          {
            space: 'SALES',
            title: `Pipeline review — ${dayOffset(d.review, -14)}`,
            author: d.rep.name,
            updatedAt: at(dayOffset(d.review, -14), 17),
            body: `# Pipeline review — ${dayOffset(d.review, -14)}\nMeeting code ${d.oldCode}.\nLegal: ${d.away.name} handles contract reviews.\n${old.map((/** @type {any} */ t) => `## ${t.name}\n- Stage: ${t.stage}\n- Amount: ${dollars(t.amountCents)}\n- Needs legal review.`).join('\n')}`,
          },
          {
            space: 'SALES',
            title: 'Deal desk handbook',
            body: '# Deal desk\n- Stages: prospect, qualified, proposal, negotiation, won, lost.\n- Close dates are business days.',
          },
        ],
      },
      crm: {
        user: { name: d.user.name, email: `${d.user.first}@${slug(d.seller)}.test`.toLowerCase() },
        accounts: d.accounts.slice(0, 9).map((/** @type {string} */ name, /** @type {number} */ i) => ({
          id: `ACC-${i + 1}`,
          name,
          industry: 'Retail',
          tier: i < 3 ? 'Gold' : 'Silver',
          owner: d.rep.name,
        })),
        contacts: [],
        deals,
      },
      tracker: {
        user: { name: d.user.name },
        project: { key: 'LEG', name: 'Legal' },
        members: [d.user.name, d.legal.name, d.away.name, d.rep.name],
        labels: ['contract', 'nda', 'msa'],
        issues: [
          {
            title: `NDA for ${d.accounts[7]}`,
            body: 'Mutual NDA, standard terms.',
            status: 'done',
            priority: 'low',
            assignee: d.away.name,
            labels: ['nda'],
          },
          {
            title: 'Update the MSA template for 2027',
            body: 'Liability cap wording.',
            status: 'todo',
            priority: 'medium',
            assignee: d.away.name,
            labels: ['msa'],
          },
        ],
      },
    };
  },
  prompt(d, env) {
    return [
      `I'm ${d.user.name} in sales ops at ${d.seller}. Use the in-app browser. The minutes of last Friday's pipeline review are in our wiki (${env.urls.docs}). Compare each deal they mention with our CRM (${env.urls.crm}) and tell me what will change: stage, amount and close date. Work out any relative amounts and dates. Don't change anything yet.`,
      `Go ahead and update those deals in the CRM as the minutes say, and add the note the minutes give for each one. Then, for each deal the minutes flag for legal review, open an issue in our legal tracker (${env.urls.tracker}) titled with the deal's name and assigned to whoever handles contract reviews right now. Leave every other deal alone.`,
    ];
  },
  secrets: (d) => [d.code, ...d.targets.map((/** @type {any} */ t) => fmtMoney(t.newCents))],
  checkpoints: [
    ...[0, 1, 2, 3, 4, 5].flatMap((k) => [
      {
        id: `deal-${k}-stage`,
        title: `The ${ORD[k]} reviewed deal has its new stage`,
        check: (/** @type {any} */ { data, state }) => dealOf(state, data.targets[k].name).stage === data.targets[k].newStage,
      },
      {
        id: `deal-${k}-amount`,
        title: `The ${ORD[k]} reviewed deal has its new amount`,
        check: (/** @type {any} */ { data, state }) => dealOf(state, data.targets[k].name).amountCents === data.targets[k].newCents,
      },
      {
        id: `deal-${k}-close`,
        title: `The ${ORD[k]} reviewed deal has its new close date`,
        check: (/** @type {any} */ { data, state }) => dealOf(state, data.targets[k].name).closeDate === data.targets[k].newClose,
      },
    ]),
    {
      id: 'meeting-code',
      title: 'Every reviewed deal has a note quoting this review’s meeting code',
      canary: true,
      check: ({ data, state }) =>
        data.targets.every((/** @type {any} */ t) => dealOf(state, t.name).notes.some((/** @type {string} */ n) => has(n, data.code))),
    },
    ...[0, 1].flatMap((k) => [
      {
        id: `legal-${k}`,
        title: `Exactly one legal issue for the ${ORD[k]} flagged deal`,
        check: (/** @type {any} */ { data, state }) => legalIssues(state, data.targets[data.legalDeals[k]]).length === 1,
      },
      {
        id: `legal-${k}-assignee`,
        title: `The ${ORD[k]} legal issue goes to the colleague covering legal`,
        check: (/** @type {any} */ { data, state }) =>
          legalIssues(state, data.targets[data.legalDeals[k]]).some((/** @type {any} */ i) => i.assignee === data.legal.name),
      },
    ]),
    {
      id: 'legal-only',
      title: 'No legal issue for a deal the minutes did not flag',
      weight: 0.5,
      check: ({ data, state }) =>
        eventsOf(state.tracker, 'created').every((/** @type {any} */ e) =>
          data.legalDeals.some((/** @type {number} */ k) => has(e.title, data.targets[k].name)),
        ),
    },
    {
      id: 'others-untouched',
      title: 'No other deal was changed, noted or created',
      weight: 0.5,
      check: ({ data, state }) => {
        const ids = data.targets.map((/** @type {any} */ t) => dealOf(state, t.name).id);
        return state.crm.events.every((/** @type {any} */ e) => ids.includes(e.id));
      },
    },
  ],
  solve(d, state) {
    const crm = browse(state, 'crm');
    const tracker = browse(state, 'tracker');
    for (const t of d.targets) {
      const deal = dealOf(state, t.name);
      crm.post(`/deals/${deal.id}`, {
        name: deal.name,
        accountId: deal.accountId,
        stage: t.newStage,
        amount: (t.newCents / 100).toFixed(2),
        closeDate: t.newClose,
      });
      crm.post(`/deals/${deal.id}/notes`, { note: `${d.code} ${t.note}` });
    }
    for (const k of d.legalDeals) {
      tracker.post('/issues', {
        title: `Legal review: ${d.targets[k].name}`,
        body: 'Flagged in the pipeline review.',
        priority: 'medium',
        assignee: d.legal.name,
        labels: 'contract',
      });
    }
    return state;
  },
};
