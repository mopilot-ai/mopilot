// MGB task f2-expense-report (#1381, F2): download a month of receipts (PDFs and a photo) from webmail, apply the
// expense policy (a meal cap, no alcohol), claim them in the tracker, and keep a CSV and the receipts on the Mac.
import { has, same } from '../grade.mjs';
import { dayOffset, distinct, fmtMoney, parseMoney, people } from '../seed.mjs';
import { at, mentionsAmount } from './common.mjs';
import { browse } from './drive.mjs';
import { bodyBytes, csvTable, fileAt, monthName, pathsWithSha, pdfBase64, putFile, sha256Of, solidPng } from './f2Common.mjs';

export const POLICY = 'Expense policy';
export const COLUMNS = ['date', 'merchant', 'amount', 'claimed'];
const MEALS = ['Harbor Bistro', 'Juniper Kitchen', 'Copper Pot Diner', 'Saltwater Grill', 'Olive and Thyme'];
const BARS = ['Driftwood Cellar', 'The Ironbark Room', 'Cellar Door'];
const TAXIS = ['CityCab', 'Metro Taxi', 'Blue Line Cabs'];
const HOTELS = ['Harbourview Hotel', 'Station Inn', 'Quayside Rooms'];

/** The month the claim covers: the one before the run's. @param {string} today */
const lastMonth = (today) => dayOffset(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
/** @param {any} d */
export const issueTitle = (d) => `Expenses ${monthName(d.month)}`;
/** @param {any} d */
export const csvName = (d) => `expenses-${d.month}.csv`;
/** The one claim issue, when there is exactly one. @param {any} d @param {any} state */
const claim = (d, state) => {
  const list = state.tracker.issues.filter((/** @type {any} */ i) => same(i.title, issueTitle(d)));
  return list.length === 1 ? list[0] : null;
};
/** The SHA-256 of each file attached to the claim. @param {any} d @param {any} state @returns {string[]} */
const attachedShas = (d, state) => (claim(d, state)?.attachments ?? []).map((/** @type {any} */ a) => sha256Of(a.data));

/** The PDF lines of one receipt. @param {any} rc */
const receiptLines = (rc) => [
  rc.merchant,
  `Date: ${rc.date}`,
  ...rc.items.map((/** @type {[string, number]} */ [name, cents]) => `${name}  ${fmtMoney(cents)}`),
  `Total: ${fmtMoney(rc.cents)}`,
  'Thank you for your visit!',
];

/** @type {import('../schema.mjs').Task} */
export const task = {
  id: 'f2-expense-report',
  family: 'F2',
  title: 'Claim a month of emailed receipts under the expense policy and file them on the Mac',
  surfaces: ['iab', 'cu'],
  tier: 'full',
  apps: ['mail', 'tracker', 'docs'],
  actions: [30, 80],
  cards: 0,
  data(r, env) {
    const company = r.company();
    const [user, approver] = people(r, 2, `${company.toLowerCase().replace(/[^a-z]+/g, '')}.test`);
    const month = lastMonth(env.today);
    const days = r
      .sample(
        Array.from({ length: 26 }, (_, i) => i + 2),
        5,
      )
      .sort((a, b) => a - b);
    const capCents = r.int(35, 60) * 100;
    const names = distinct(() => `Receipt-${r.int(10000, 99999)}.pdf`, 4);
    const kinds = r.shuffle(['meal-over', 'meal-under', 'alcohol', 'taxi', 'hotel']);
    const [mealA, mealB] = r.sample(MEALS, 2);
    const receipts = kinds.map((kind, i) => {
      const date = `${month}-${String(days[i]).padStart(2, '0')}`;
      const c = r.int(0, 99);
      if (kind === 'meal-over' || kind === 'meal-under') {
        const cents = kind === 'meal-over' ? capCents + r.int(5, 40) * 100 + c : capCents - r.int(5, 25) * 100 + c;
        const mains = cents - 450;
        return {
          kind,
          date,
          merchant: kind === 'meal-over' ? mealA : mealB,
          cents,
          claimed: Math.min(cents, capCents),
          items: [
            ['Dinner, 2 mains', mains],
            ['Sparkling water', 450],
          ],
        };
      }
      if (kind === 'alcohol') {
        const cents = r.int(30, 90) * 100 + c;
        return {
          kind,
          date,
          merchant: r.pick(BARS),
          cents,
          claimed: 0,
          items: [
            ['Bottle of red wine', cents - 1400],
            ['2 x Glass of prosecco', 1400],
          ],
        };
      }
      const cents = kind === 'taxi' ? r.int(18, 60) * 100 + c : r.int(120, 260) * 100 + c;
      return {
        kind,
        date,
        merchant: r.pick(kind === 'taxi' ? TAXIS : HOTELS),
        cents,
        claimed: cents,
        items: [[kind === 'taxi' ? 'Airport ride' : 'Room, 1 night', cents]],
      };
    });
    let pdf = 0;
    for (const rc of receipts) {
      // the taxi receipt is a phone photo; the others are PDFs the merchants sent
      if (rc.kind === 'taxi')
        Object.assign(rc, {
          name: `IMG_${r.int(1000, 9999)}.png`,
          type: 'image/png',
          base64: solidPng(24, 32, [r.int(200, 255), r.int(200, 255), r.int(180, 230)]).toString('base64'),
        });
      else Object.assign(rc, { name: names[pdf++], type: 'application/pdf', base64: pdfBase64(receiptLines(rc)) });
    }
    return {
      company,
      user,
      approver,
      month,
      capCents,
      receipts,
      totalCents: receipts.reduce((t, rc) => t + rc.claimed, 0),
      costCenter: r.token('CC', 5),
    };
  },
  fixtures(d, env) {
    const messages = d.receipts.map((/** @type {any} */ rc) =>
      rc.kind === 'taxi'
        ? {
            from: { name: d.user.name, email: d.user.email },
            subject: 'Taxi receipt (photo)',
            body: `Photo of the paper receipt: ${rc.merchant}, airport ride on ${rc.date}, ${fmtMoney(rc.cents)}.`,
            date: at(rc.date, 22),
            attachments: [{ name: rc.name, type: rc.type, base64: rc.base64 }],
          }
        : {
            from: { name: rc.merchant, email: `receipts@${rc.merchant.toLowerCase().replace(/[^a-z]+/g, '')}.test` },
            subject: `Your receipt from ${rc.merchant}`,
            body: 'Thank you for your visit. Your receipt is attached.',
            date: at(rc.date, 21),
            attachments: [{ name: rc.name, type: rc.type, base64: rc.base64 }],
          },
    );
    return {
      mail: {
        user: { name: d.user.name, email: d.user.email },
        messages: [
          ...messages,
          {
            from: { name: d.approver.name, email: d.approver.email },
            subject: 'Expense claims this month',
            body: 'Please get your claims in by Friday.',
            date: at(dayOffset(env.today, -2), 9),
          },
          {
            from: { name: 'Travel desk', email: `travel@${d.user.email.split('@')[1]}` },
            subject: 'New booking tool',
            body: 'Book hotels through the new portal from next month.',
            date: at(dayOffset(env.today, -6), 11),
          },
        ],
      },
      tracker: {
        user: { name: d.user.name },
        project: { key: 'EXP', name: 'Expenses' },
        members: [d.user.name, d.approver.name],
        labels: ['expenses', 'travel'],
        issues: [
          {
            title: `Expenses ${monthName(lastMonth(`${d.month}-01`))}`,
            body: 'Paid.',
            status: 'done',
            assignee: d.approver.name,
            labels: ['expenses'],
          },
        ],
      },
      docs: {
        user: { name: d.user.name },
        spaces: [{ key: 'FIN', name: 'Finance' }],
        pages: [
          {
            space: 'FIN',
            title: POLICY,
            author: d.approver.name,
            updatedAt: at(dayOffset(env.today, -60), 10),
            body: [
              '# Expense policy',
              `- Meals are reimbursed up to ${fmtMoney(d.capCents)} per receipt; anything above that is yours to pay.`,
              '- Alcohol is never reimbursed.',
              '- Taxis, hotels and office supplies are reimbursed in full.',
              '## How to claim',
              '- One tracker issue per month, titled "Expenses <Month YYYY>", for example "Expenses March 2026".',
              `- Attach every receipt you claim, and none you cannot. In the description give the claimable total and our cost-center code ${d.costCenter}.`,
            ].join('\n'),
          },
          {
            space: 'FIN',
            title: 'Travel booking',
            body: 'Book flights two weeks ahead where you can.',
            updatedAt: at(dayOffset(env.today, -20), 10),
          },
        ],
      },
      files: { entries: {} },
    };
  },
  prompt(d, env) {
    const month = monthName(d.month);
    return [
      `I'm ${d.user.name} at ${d.company}. My receipts for ${month} are in my mailbox (${env.urls.mail}), as attachments. Use the in-app browser for the websites and the Mac's apps (Finder, Preview, TextEdit) for files. Download every receipt, open each one on the Mac to read its merchant, date and amount, and read our "${POLICY}" page in the docs (${env.urls.docs}). Tell me what I can claim and why; don't file anything yet.`,
      `Now file my ${month} claim in the expenses tracker (${env.urls.tracker}) the way the policy says, attaching the receipts from your downloads. Then, in ${env.files}, create ${csvName(d)} with the header ${COLUMNS.join(',')} and one row per receipt (the amount on the receipt, and what I can claim for it), and move all the downloaded receipts into a "receipts" folder there.`,
    ];
  },
  secrets: (d) => [d.costCenter, fmtMoney(d.totalCents), fmtMoney(d.capCents)],
  checkpoints: [
    { id: 'issue', title: 'One claim issue for the month', check: ({ data, state }) => !!claim(data, state) },
    {
      id: 'issue-receipts',
      title: 'Every claimable receipt, the photo included, is attached to the claim',
      check: ({ data, state }) => {
        const shas = attachedShas(data, state);
        return data.receipts
          .filter((/** @type {any} */ rc) => rc.claimed > 0)
          .every((/** @type {any} */ rc) => shas.includes(sha256Of(rc.base64)));
      },
    },
    {
      id: 'issue-no-alcohol',
      title: 'The excluded receipt is not attached to the claim',
      weight: 0.5,
      check: ({ data, state }) => {
        const bar = data.receipts.find((/** @type {any} */ rc) => rc.claimed === 0);
        return !!claim(data, state) && !attachedShas(data, state).includes(sha256Of(bar.base64));
      },
    },
    {
      id: 'issue-total',
      title: 'The claim gives the claimable total: the meal capped, the alcohol left out',
      check: ({ data, state }) => mentionsAmount(claim(data, state)?.body, data.totalCents),
    },
    {
      id: 'cost-center',
      title: 'The claim gives the policy’s cost-center code',
      canary: true,
      check: ({ data, state }) => has(claim(data, state)?.body, data.costCenter),
    },
    {
      id: 'csv-file',
      title: 'The month’s CSV is in the folder with the asked-for header',
      check: ({ data, state }) => !!csvTable(fileAt(state.files, csvName(data))?.text, COLUMNS),
    },
    {
      id: 'csv-rows',
      title: 'The CSV has one row per receipt with its date, merchant, amount and claimable amount',
      check: ({ data, state }) => {
        const rows = csvTable(fileAt(state.files, csvName(data))?.text, COLUMNS) ?? [];
        return (
          rows.length === data.receipts.length &&
          data.receipts.every((/** @type {any} */ rc) =>
            rows.some(
              (r) =>
                r.date === rc.date &&
                (has(r.merchant, rc.merchant) || has(rc.merchant, r.merchant)) &&
                parseMoney(r.amount) === rc.cents &&
                parseMoney(r.claimed) === rc.claimed,
            ),
          )
        );
      },
    },
    {
      id: 'receipts-filed',
      title: 'Every downloaded receipt is in the receipts folder',
      check: ({ data, state }) =>
        data.receipts.every((/** @type {any} */ rc) => pathsWithSha(state.files, sha256Of(rc.base64), 'receipts/').length > 0),
    },
  ],
  solve(d, state) {
    const mail = browse(state, 'mail');
    const files = [];
    for (const rc of d.receipts) {
      const msg = state.mail.messages.find((/** @type {any} */ m) => m.attachments[0]?.name === rc.name);
      const bytes = bodyBytes(mail.get(`/m/${msg.id}/att/0`));
      putFile(state, `receipts/${rc.name}`, bytes);
      if (rc.claimed > 0) files.push({ field: 'attach', name: rc.name, type: rc.type, content: bytes });
    }
    browse(state, 'tracker').post('/issues', {
      fields: {
        title: issueTitle(d),
        body: `Claimable total: ${fmtMoney(d.totalCents)}\nCost center: ${d.costCenter}`,
        priority: 'medium',
        labels: 'expenses',
      },
      files,
    });
    const rows = d.receipts.map((/** @type {any} */ rc) =>
      [rc.date, rc.merchant, (rc.cents / 100).toFixed(2), (rc.claimed / 100).toFixed(2)].join(','),
    );
    putFile(state, csvName(d), Buffer.from([COLUMNS.join(','), ...rows].join('\n'), 'utf8'));
    return state;
  },
};
