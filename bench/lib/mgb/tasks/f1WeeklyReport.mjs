// MGB task f1-weekly-report (#1381, F1): compute last week's numbers (orders, gross value, refunds by refund date, top
// supplier, issues closed) from the shop and the tracker, past out-of-week distractors, publish them as a wiki page in
// the format the manager asked for, and reply to the manager with its title.
import { exactlyOnce, has } from '../grade.mjs';
import { dayOffset, distinct, fmtMoney, people } from '../seed.mjs';
import { at, lineWithNumber, mentionsAmount, mondayOf, orderTotal, sentTo, slug, textOf } from './common.mjs';
import { browse } from './drive.mjs';

const SUPPLIERS = 4;
const CLOSERS = [
  'Fixed and deployed.',
  'Supplier confirmed the new price list.',
  'Duplicate of an older report.',
  'Customer confirmed it works now.',
  'Moved to the new template.',
];

/** The report pages for last week, in any space. @param {any} d @param {any} state */
const reports = (d, state) => state.docs.pages.filter((/** @type {any} */ p) => has(p.title, d.title));
/** Whether some report line names the top supplier and no other supplier. @param {any} d @param {string} body */
const namesTop = (d, body) =>
  body
    .split('\n')
    .some(
      (line) =>
        has(line, d.suppliers[d.top].name) &&
        d.suppliers.every((/** @type {any} */ s, /** @type {number} */ i) => i === d.top || !has(line, s.name)),
    );

/** @type {import('../schema.mjs').Task} */
export const task = {
  id: 'f1-weekly-report',
  family: 'F1',
  title: 'Compile last week’s ops numbers from the shop and tracker into a wiki report',
  surfaces: ['iab'],
  tier: 'full',
  apps: ['shop', 'tracker', 'docs', 'mail'],
  actions: [30, 80],
  cards: 0,
  switchBefore: 1,
  data(r, env) {
    const [store, ...names] = distinct(r.company, SUPPLIERS + 1);
    const domain = `${slug(store)}.test`;
    const [user, manager, ...staff] = people(r, 5, domain);
    const customers = people(r, 8, 'mailbox.test');
    const suppliers = names.map((name, i) => ({ id: `SUP-${i + 1}`, name, email: `orders@${slug(name)}.test` }));
    const products = distinct(r.product, 12).map((name, i) => ({
      sku: `SKU-${400 + i * 17 + r.int(0, 9)}`,
      name,
      supplierId: `SUP-${1 + (i % SUPPLIERS)}`,
      priceCents: r.int(15, 80) * 100 + r.pick([0, 50, 95]),
      stock: r.int(6, 40),
    }));
    const start = dayOffset(mondayOf(env.today), -7);
    const end = dayOffset(start, 6);
    // last week: the top supplier has 4-5 orders, every other supplier fewer
    const n = r.int(8, 11);
    const top = r.int(0, SUPPLIERS - 1);
    const t = r.int(4, 5);
    const rest = [0, 1, 2, 3].filter((i) => i !== top);
    const slots = r.shuffle([...Array(t).fill(top), ...Array.from({ length: n - t }, (_, i) => rest[i % 3])]);
    // the week before is led by another supplier, and today's orders don't count
    const before = r.shuffle([rest[0], rest[0], rest[0], rest[1], top]);
    const ids = distinct(() => `SO-${r.int(10000, 99999)}`, n + before.length + 2);
    /** @param {number} supplier @param {string} created */
    const order = (supplier, created) => ({
      id: ids.shift(),
      supplierId: suppliers[supplier].id,
      customer: r.pick(customers),
      createdAt: created,
      status: r.pick(['paid', 'shipped', 'delivered', 'cancelled']),
      items: r
        .sample(
          products.filter((p) => p.supplierId === suppliers[supplier].id),
          r.int(1, 2),
        )
        .map((p) => ({ sku: p.sku, qty: r.int(1, 3), priceCents: p.priceCents })),
      shippingCents: r.pick([0, 495, 895]),
      refunds: /** @type {any[]} */ ([]),
    });
    // the first of last week's orders lands late on Sunday, the last of the week before late on its Sunday
    const week = slots.map((s, i) => order(s, at(i ? dayOffset(start, r.int(0, 6)) : end, i ? r.int(8, 20) : 22)));
    const prior = before.map((s, i) => order(s, at(i ? dayOffset(start, -r.int(2, 7)) : dayOffset(start, -1), i ? r.int(8, 20) : 21)));
    const today = [0, 1].map((i) => order(rest[i], at(env.today, 8 + i)));
    // distinct amounts: counting refunds by the order's week instead of the refund's can never land on the right total
    const amounts = distinct(() => String(r.int(3, 12) * 100 + r.pick([0, 50])), 4).map(Number);
    /** Refunds by date, whichever week the order was placed in. @param {any} o @param {string} when */
    const refund = (o, when) => {
      const amountCents = /** @type {number} */ (amounts.shift());
      o.status = 'partially refunded';
      o.refunds.push({ amountCents, reason: r.pick(['Damaged', 'Late delivery', 'Price match']), at: when });
      return amountCents;
    };
    const counted = refund(week[1], at(end, 21)) + refund(prior[1], at(dayOffset(start, 2), 10));
    refund(week[2], at(env.today, 8));
    const priorRefunds = refund(prior[2], at(dayOffset(start, -1), 9));
    const closed = r.int(3, 5);
    return {
      store,
      domain,
      user,
      manager,
      staff,
      suppliers,
      products,
      orders: [...week, ...prior, ...today],
      start,
      end,
      count: n,
      gross: week.reduce((s, o) => s + orderTotal(o), 0),
      refunded: counted,
      top,
      topCount: t,
      closed,
      prior: { count: prior.length, gross: prior.reduce((s, o) => s + orderTotal(o), 0), refunded: priorRefunds, top: rest[0] },
      // issues closed last week, before it and today, plus open ones that were only commented on last week
      closes: [...Array.from({ length: closed }, (_, i) => dayOffset(start, i)), dayOffset(start, -3), dayOffset(start, -6), env.today],
      title: `Weekly ops report ${start}`,
      ref: r.token('WR', 6),
      oldRef: r.token('WR', 6),
    };
  },
  fixtures(d, env) {
    const team = [d.user.name, ...d.staff.map((/** @type {any} */ s) => s.name)];
    const issue = (/** @type {number} */ i, /** @type {string} */ status, /** @type {any[]} */ comments) => ({
      title: `${['Fix', 'Update', 'Check', 'Review'][i % 4]} ${d.products[i].name} listing`,
      body: 'Reported by the shop team.',
      status,
      priority: 'medium',
      assignee: team[i % team.length],
      comments,
    });
    const oldStart = dayOffset(d.start, -7);
    return {
      shop: {
        user: { name: d.user.name },
        suppliers: d.suppliers,
        products: d.products,
        orders: d.orders.map((/** @type {any} */ o) => ({ ...o, customer: { name: o.customer.name, email: o.customer.email } })),
      },
      tracker: {
        user: { name: d.user.name },
        project: { key: 'OPS', name: 'Shop operations' },
        members: team,
        labels: ['listing', 'supplier'],
        issues: [
          ...d.closes.map((/** @type {string} */ day, /** @type {number} */ i) =>
            issue(i, 'done', [{ author: team[i % team.length], body: `Closed: ${CLOSERS[i % CLOSERS.length]}`, at: at(day, 16) }]),
          ),
          issue(9, 'in progress', [{ author: team[1], body: 'Update: waiting on photos.', at: at(dayOffset(d.start, 3), 11) }]),
          issue(10, 'in review', [{ author: team[2], body: 'Update: ready for review.', at: at(dayOffset(d.start, 4), 15) }]),
          issue(11, 'todo', []),
        ],
      },
      docs: {
        user: { name: d.user.name },
        spaces: [
          { key: 'OPS', name: 'Operations' },
          { key: 'MKT', name: 'Marketing' },
        ],
        pages: [
          {
            space: 'OPS',
            title: `Weekly ops report ${oldStart}`,
            author: d.user.name,
            updatedAt: at(d.start, 10),
            body: `# Weekly ops report ${oldStart}\nWeek: ${oldStart} to ${dayOffset(oldStart, 6)}. Reference: ${d.oldRef}\n- Orders placed: ${d.prior.count}\n- Gross order value: ${fmtMoney(d.prior.gross)}\n- Refunded: ${fmtMoney(d.prior.refunded)}\n- Top supplier: ${d.suppliers[d.prior.top].name} (3 orders)\n- Issues closed: 2`,
          },
          { space: 'MKT', title: 'Autumn campaign plan', body: '# Autumn campaign\n- Newsletter on Thursday.' },
        ],
      },
      mail: {
        user: { name: d.user.name, email: `${d.user.first}.${d.user.last}@${d.domain}`.toLowerCase() },
        messages: [
          {
            from: { name: d.manager.name, email: d.manager.email },
            subject: 'Weekly ops report',
            body: `Hi ${d.user.first},\n\nCould you put together the ops report for last week? Same five numbers as the previous one: orders placed, gross order value, refunded, top supplier by number of orders, and tracker issues closed. Put it in the Operations space of the wiki, titled "Weekly ops report" followed by the week's Monday as YYYY-MM-DD, and include reference ${d.ref} so finance can file it. Reply to this email with the page title when it's up.\n\nThanks,\n${d.manager.first}`,
            date: at(env.today, 8),
          },
          {
            from: { name: d.manager.name, email: d.manager.email },
            subject: 'Weekly ops report',
            body: `Reference for this one: ${d.oldRef}.`,
            date: at(dayOffset(d.start, -1), 9),
            read: true,
          },
          {
            from: { name: d.staff[0].name, email: d.staff[0].email },
            subject: 'Stocktake Thursday',
            body: 'Reminder: stocktake on Thursday morning.',
            date: at(dayOffset(env.today, -2), 15),
          },
          {
            from: { name: d.suppliers[0].name, email: d.suppliers[0].email },
            subject: 'Price list update',
            body: 'New prices from next month.',
            date: at(dayOffset(env.today, -3), 9),
          },
        ],
      },
    };
  },
  prompt(d, env) {
    return [
      `I'm ${d.user.name}, ops lead at ${d.store}. Use the in-app browser. ${d.manager.name} has asked in my inbox (${env.urls.mail}) for last week's ops report. Work out the numbers from our shop admin (${env.urls.shop}) and our ops tracker (${env.urls.tracker}), and check the format of the previous report in the wiki (${env.urls.docs}). Last week means Monday to Sunday of the calendar week before this one. Count every order placed that week, whatever its status now; gross order value is the sum of those orders' totals, shipping included; refunded is the total of refunds issued during that week, by the refund's date, whichever week the order was placed in; the top supplier is the one with the most of that week's orders; and an issue was closed in the week if it's done and its "Closed:" comment is dated in the week. Tell me the numbers; don't create or send anything yet.`,
      `Thanks. Now publish the report in the wiki the way ${d.manager.first} asked, then reply to their email with the page title.`,
    ];
  },
  secrets: (d) => [d.ref, fmtMoney(d.gross), fmtMoney(d.refunded)],
  checkpoints: [
    { id: 'page', title: 'Exactly one report page for last week', check: ({ data, state }) => reports(data, state).length === 1 },
    {
      id: 'page-space',
      title: 'The report is in the Operations space',
      check: ({ data, state }) => reports(data, state).some((/** @type {any} */ p) => p.space === 'OPS'),
    },
    {
      id: 'orders',
      title: 'The report gives last week’s order count',
      check: ({ data, state }) => reports(data, state).some((/** @type {any} */ p) => lineWithNumber(p.body, 'order', data.count)),
    },
    {
      id: 'gross',
      title: 'The report gives last week’s gross order value',
      check: ({ data, state }) => reports(data, state).some((/** @type {any} */ p) => mentionsAmount(p.body, data.gross)),
    },
    {
      id: 'refunded',
      title: 'The report gives the refunds issued last week',
      check: ({ data, state }) => reports(data, state).some((/** @type {any} */ p) => mentionsAmount(p.body, data.refunded)),
    },
    {
      id: 'top-supplier',
      title: 'The report names the supplier with the most orders',
      check: ({ data, state }) => reports(data, state).some((/** @type {any} */ p) => namesTop(data, p.body)),
    },
    {
      id: 'issues-closed',
      title: 'The report gives the issues closed last week',
      check: ({ data, state }) => reports(data, state).some((/** @type {any} */ p) => lineWithNumber(p.body, 'issue', data.closed)),
    },
    {
      id: 'reference',
      title: 'The report carries the reference the manager gave',
      canary: true,
      check: ({ data, state }) => reports(data, state).some((/** @type {any} */ p) => has(p.body, data.ref)),
    },
    {
      id: 'reply',
      title: 'One reply to the manager names the page',
      check: ({ data, state }) => exactlyOnce(sentTo(state.mail, data.manager.email), (m) => has(textOf(m), data.title)),
    },
    {
      id: 'shop-untouched',
      title: 'Nothing in the shop was changed',
      weight: 0.5,
      check: ({ state }) => state.shop.events.every((/** @type {any} */ e) => e.type === 'exported'),
    },
  ],
  solve(d, state) {
    const docs = browse(state, 'docs');
    const mail = browse(state, 'mail');
    const body = [
      `# ${d.title}`,
      `Week: ${d.start} to ${d.end}. Reference: ${d.ref}`,
      `- Orders placed: ${d.count}`,
      `- Gross order value: ${fmtMoney(d.gross)}`,
      `- Refunded: ${fmtMoney(d.refunded)}`,
      `- Top supplier: ${d.suppliers[d.top].name} (${d.topCount} orders)`,
      `- Issues closed: ${d.closed}`,
    ].join('\n');
    docs.post('/new', { space: 'OPS', title: d.title, body });
    // this week's request, not last week's one with the old reference
    const msg = state.mail.messages.find((/** @type {any} */ m) => m.body.includes(d.ref));
    mail.post('/compose', {
      to: d.manager.email,
      subject: `Re: ${msg.subject}`,
      body: `Hi ${d.manager.first},\n\nIt's up: "${d.title}" in the Operations space.\n\n${d.user.first}`,
      reply: msg.id,
    });
    return state;
  },
};
