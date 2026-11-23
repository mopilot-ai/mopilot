// MGB task f5-hiring-research (#1381, F5): research four candidates' profile pages (one has a namesake) in the in-app
// browser, draft a panel brief in TextEdit, then shortlist two in the CRM from the user's Chrome and mail the manager.
import { exactlyOnce, has, same } from '../grade.mjs';
import { dayOffset, people } from '../seed.mjs';
import { at, sentTo, slug, textOf, wholeNumbers } from './common.mjs';
import { browse } from './drive.mjs';
import { fileAt, putFile } from './f2Common.mjs';
import { allInChrome, linesOf, viewedInApp } from './f5Common.mjs';

export const FILE = 'panel-brief.md';
const ROLES = ['Senior data engineer', 'Analytics engineer', 'Platform engineer', 'Site reliability engineer', 'Backend engineer'];
const SKILLS = ['Python', 'SQL', 'Spark', 'Airflow', 'dbt', 'Kafka', 'Terraform', 'Kubernetes', 'Scala', 'Tableau', 'Snowflake', 'Rust'];
const JOBS = ['Data analyst', 'Software engineer', 'Data engineer', 'Systems administrator', 'Research assistant'];
/** The candidates by part: a and b are shortlisted, c shares a name with someone who applied for another role. */
export const KEYS = ['a', 'b', 'c', 'd'];

/** The title a shortlisted candidate's contact gets. @param {any} d */
export const shortlistedTitle = (d) => `Shortlisted – ${d.role}`;
/** A candidate by part. @param {any} d @param {string} key */
export const candidate = (d, key) => d.candidates[KEYS.indexOf(key)];

/**
 * A work history of `years` years in two jobs ending this year, maybe with a gap between them, and skills with
 * endorsements: one skill off the role's list leads, so "top skill" needs the list.
 * @param {import('../seed.mjs').Rng} r @param {number} years @param {number} year @param {string[]} must
 */
function career(r, years, year, must) {
  const first = r.int(1, years - 1);
  const gap = r.int(0, 2);
  const start2 = year - (years - first);
  const jobs = [
    { from: start2 - gap - first, to: start2 - gap, title: r.pick(JOBS), at: r.company() },
    { from: start2, to: year, title: r.pick(JOBS), at: r.company() },
  ];
  const matching = r.sample(must, r.int(2, 3));
  const counts = r
    .sample(
      [...Array(38).keys()].map((k) => k + 3),
      matching.length + 1,
    )
    .sort((x, y) => y - x);
  const skills = [
    { name: r.pick(SKILLS.filter((s) => !must.includes(s))), endorsements: counts[0] },
    ...matching.map((name, i) => ({ name, endorsements: counts[i + 1] })),
  ];
  return { years, jobs, skills, top: skills[1].name };
}

/** The brief's lines that name a candidate and give both their years and their top matching skill. @param {string} text @param {any} c */
export const briefOk = (text, c) => linesOf(text).some((l) => has(l, c.name) && wholeNumbers(l).includes(c.years) && has(l, c.top));

/** The brief the oracle writes. @param {any} d */
export const briefFor = (d) =>
  [
    `# Panel brief: ${d.role}`,
    ...d.mailOrder.map((/** @type {number} */ i) => {
      const c = d.candidates[i];
      return `- ${c.name}: ${c.years} years of experience, top skill ${c.top}`;
    }),
  ].join('\n');

/** The contacts and deals of everyone but the shortlisted two. @param {any} d */
const others = (d) => [...d.candidates.slice(2), d.namesake];

/** @type {import('../schema.mjs').Task} */
export const task = {
  id: 'f5-hiring-research',
  family: 'F5',
  title: 'Research candidates in the in-app browser, brief the panel in TextEdit, and shortlist them in the CRM from Chrome',
  surfaces: ['iab', 'cu', 'bu'],
  tier: 'full',
  apps: ['docs', 'crm', 'mail'],
  actions: [40, 80],
  cards: { min: 0, max: 1 },
  data(r, env) {
    const company = r.company();
    const [user, manager] = people(r, 2, `${slug(company)}.test`);
    const [role, otherRole] = r.sample(ROLES, 2);
    const must = r.sample(SKILLS, 5);
    const year = Number(env.today.slice(0, 4));
    // the namesake has the most years: mixing them up shortlists c instead of b
    const [ny, ay, by, ...rest] = r
      .sample(
        [...Array(14).keys()].map((k) => k + 3),
        5,
      )
      .sort((x, y) => y - x);
    const people4 = people(r, 4, 'homemail.test');
    // record ids in no telling order: the shortlisted two are not CON-1 and CON-2
    const ids = r.shuffle([1, 2, 3, 4, 5]);
    const candidates = people4.map((p, i) => ({
      key: KEYS[i],
      first: p.first,
      last: p.last,
      name: p.name,
      email: `${p.first}.${p.last}${r.int(10, 99)}@homemail.test`.toLowerCase(),
      contact: `CON-${ids[i]}`,
      deal: `DEAL-${ids[i]}`,
      ...career(r, [ay, by, ...rest][i], year, must),
    }));
    const c = candidates[2];
    const namesake = {
      key: 'namesake',
      first: c.first,
      last: c.last,
      name: c.name,
      email: `${c.first}${c.last[0]}@mailbox.test`.toLowerCase(),
      contact: `CON-${ids[4]}`,
      deal: `DEAL-${ids[4]}`,
      ...career(r, ny, year, must),
    };
    return {
      company,
      user,
      manager,
      role,
      otherRole,
      must,
      candidates,
      namesake,
      panel: r.token('PNL', 6),
      mailOrder: r.shuffle([0, 1, 2, 3]),
      // page ids in no telling order: the namesake's pages are not the last ones
      pageIds: r.shuffle([...Array(10).keys()].map((k) => `PG-${k + 2}`)),
    };
  },
  fixtures(d, env) {
    const all = [...d.candidates, d.namesake];
    const applied = (/** @type {any} */ p) => (p.key === 'namesake' ? d.otherRole : d.role);
    const pages = all.flatMap((/** @type {any} */ p, /** @type {number} */ i) => [
      {
        id: d.pageIds[2 * i],
        space: 'CAND',
        title: `${p.name}: profile`,
        updatedAt: at(dayOffset(env.today, -Number(d.pageIds[2 * i].slice(3))), 10),
        body: [
          `# ${p.name}`,
          `Applied for: ${applied(p)}`,
          `Email: ${p.email}`,
          '## Work history',
          ...[...p.jobs].reverse().map((/** @type {any} */ j) => `- ${j.from}–${j.to}: ${j.title} at ${j.at}`),
        ].join('\n'),
      },
      {
        id: d.pageIds[2 * i + 1],
        space: 'CAND',
        title: `${p.name}: skills`,
        updatedAt: at(dayOffset(env.today, -Number(d.pageIds[2 * i + 1].slice(3))), 15),
        body: [
          `# ${p.name}: skills`,
          `Applied for: ${applied(p)}`,
          ...p.skills.map((/** @type {any} */ s) => `- ${s.name}: ${s.endorsements} endorsements`),
        ].join('\n'),
      },
    ]);
    return {
      docs: {
        user: { name: d.user.name },
        spaces: [
          { key: 'HIRE', name: 'Hiring' },
          { key: 'CAND', name: 'Candidates' },
        ],
        pages: [
          {
            id: 'PG-1',
            space: 'HIRE',
            title: `Role: ${d.role}`,
            author: d.manager.name,
            updatedAt: at(dayOffset(env.today, -9), 9),
            body: [
              `# ${d.role}`,
              `Skills we hire for: ${d.must.join(', ')}.`,
              'Shortlist the two candidates for this role with the most years of experience: the sum of the years in their work history.',
              "A candidate's top skill is their most endorsed skill on the list above.",
            ].join('\n'),
          },
          ...pages,
        ],
      },
      crm: {
        user: { name: d.user.name, email: d.user.email },
        accounts: [
          { id: 'ACC-1', name: `${d.company} hiring: ${d.role}`, industry: 'Recruiting', owner: d.user.name },
          { id: 'ACC-2', name: `${d.company} talent pool`, industry: 'Recruiting', owner: d.user.name },
        ],
        contacts: all.map((/** @type {any} */ p) => ({
          id: p.contact,
          name: p.name,
          email: p.email,
          title: 'Candidate',
          accountId: p.key === 'namesake' ? 'ACC-2' : 'ACC-1',
        })),
        deals: all.map((/** @type {any} */ p) => ({
          id: p.deal,
          accountId: p.key === 'namesake' ? 'ACC-2' : 'ACC-1',
          name: `Hiring: ${p.name} (${applied(p)})`,
          stage: 'qualified',
          amountCents: 0,
          closeDate: dayOffset(env.today, 30),
        })),
      },
      mail: {
        user: { name: d.user.name, email: d.user.email },
        messages: [
          {
            from: { name: d.manager.name, email: d.manager.email },
            subject: `Candidates for ${d.role}`,
            body: [
              `Hi ${d.user.first},`,
              '',
              `Here are the candidates for the ${d.role} role:`,
              ...d.mailOrder.map((/** @type {number} */ i) => `- ${d.candidates[i].name} (${d.candidates[i].email})`),
              '',
              `Their profiles are in the Candidates space of the docs. The panel code for this round is ${d.panel}: put it in a note on each shortlisted candidate's hiring deal. Send me the shortlist when it's done.`,
              '',
              d.manager.first,
            ].join('\n'),
            date: at(dayOffset(env.today, -1), 9),
          },
          {
            from: { name: d.manager.name, email: d.manager.email },
            subject: `Candidates for ${d.otherRole}`,
            body: `Hi ${d.user.first},\n\nThe ${d.otherRole} search is on hold; no action needed.\n\n${d.manager.first}`,
            date: at(dayOffset(env.today, -6), 9),
            read: true,
          },
        ],
      },
      files: { entries: {} },
    };
  },
  prompt(d, env) {
    return [
      `I'm ${d.user.name}, recruiting a ${d.role} at ${d.company}. ${d.manager.first} emailed me the candidates (my mail: ${env.urls.mail}). In the in-app browser, read the role page and each candidate's profile and skills pages in our docs (${env.urls.docs}). Then, with TextEdit on the Mac, save ${FILE} in ${env.files} as plain text: one line per candidate with their full name, their years of experience and their top skill from the role page's list. Tell me who should be shortlisted by the role page's rule; don't change the CRM yet.`,
      `Now, from my own Chrome (not the in-app browser), update the CRM (${env.urls.crm}) for the two shortlisted candidates: set each one's contact title to "${shortlistedTitle(d)}" and add a note with ${d.manager.first}'s panel code to each one's hiring deal. Then email ${d.manager.first} the shortlist.`,
    ];
  },
  secrets: (d) => [d.panel, d.candidates[0].name, d.candidates[1].name],
  checkpoints: [
    ...KEYS.map((key) => ({
      id: `brief-${key}`,
      title: `The brief gives candidate ${key}'s years of experience and top matching skill on one line`,
      check: (/** @type {any} */ { data, state }) => briefOk(fileAt(state.files, FILE)?.text ?? '', candidate(data, key)),
    })),
    {
      id: 'titles',
      title: 'Both shortlisted candidates’ contacts have the shortlisted title',
      check: ({ data, state }) =>
        data.candidates
          .slice(0, 2)
          .every((/** @type {any} */ c) =>
            state.crm.contacts.some((/** @type {any} */ x) => x.id === c.contact && same(x.title, shortlistedTitle(data))),
          ),
    },
    {
      id: 'no-other-titles',
      title: 'No other contact’s title changed, the namesake’s included',
      weight: 0.5,
      check: ({ data, state }) =>
        others(data).every((/** @type {any} */ c) =>
          state.crm.contacts.some((/** @type {any} */ x) => x.id === c.contact && x.title === 'Candidate'),
        ),
    },
    {
      id: 'panel-notes',
      title: 'Both shortlisted candidates’ hiring deals have a note with the panel code',
      canary: true,
      check: ({ data, state }) =>
        data.candidates
          .slice(0, 2)
          .every((/** @type {any} */ c) =>
            state.crm.deals.some(
              (/** @type {any} */ x) => x.id === c.deal && x.notes.some((/** @type {string} */ n) => has(n, data.panel)),
            ),
          ),
    },
    {
      id: 'no-other-notes',
      title: 'No other hiring deal got a note',
      weight: 0.5,
      check: ({ data, state }) =>
        others(data).every((/** @type {any} */ c) => state.crm.deals.some((/** @type {any} */ x) => x.id === c.deal && !x.notes.length)),
    },
    {
      id: 'crm-in-chrome',
      title: 'The CRM changes were made in the user’s Chrome, not the in-app browser',
      check: ({ state }) => allInChrome(state.crm, ['updated', 'noteAdded']),
    },
    {
      id: 'mail-shortlist',
      title: 'One email to the manager names the two shortlisted candidates and neither of the others',
      check: ({ data, state }) => {
        const [a, b, c, dd] = data.candidates;
        return exactlyOnce(sentTo(state.mail, data.manager.email), (m) => {
          const t = textOf(m);
          return has(t, a.name) && has(t, b.name) && !has(t, c.name) && !has(t, dd.name);
        });
      },
    },
    {
      id: 'research-in-app',
      title: 'The role page and every candidate’s profile and skills pages were read in the in-app browser',
      weight: 0.5,
      check: ({ data, state }) => viewedInApp(state.docs, ['PG-1', ...data.pageIds.slice(0, 8)], (e) => e.id),
    },
  ],
  solve(d, state) {
    const docs = browse(state, 'docs');
    for (const id of ['PG-1', ...d.pageIds]) docs.get(`/p/${id}`);
    browse(state, 'mail').get(`/m/${state.mail.messages[0].id}`);
    putFile(state, FILE, Buffer.from(briefFor(d), 'utf8'));
    const crm = browse(state, 'crm');
    for (const c of d.candidates.slice(0, 2)) {
      crm.post(`/contacts/${c.contact}`, { name: c.name, email: c.email, phone: '', title: shortlistedTitle(d), accountId: 'ACC-1' });
      crm.post(`/deals/${c.deal}/notes`, { note: `Shortlisted for the panel. Panel code ${d.panel}.` });
    }
    const [a, b] = d.candidates;
    browse(state, 'mail').post('/compose', {
      to: d.manager.email,
      subject: `Shortlist: ${d.role}`,
      body: `Hi ${d.manager.first},\n\nThe shortlist is ${a.name} (${a.years} years, ${a.top}) and ${b.name} (${b.years} years, ${b.top}). Their CRM records are updated with the panel code.\n\n${d.user.first}`,
    });
    return state;
  },
};
