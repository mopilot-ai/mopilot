// MGB task f5-conference-plan (#1381, F5): read a conference agenda, speaker bios and the manager's track choice in the
// in-app browser, put the chosen sessions in Calendar and a plan in Notes on the Mac, and buy the workshop in Chrome.
import { has } from '../grade.mjs';
import { dayOffset, distinct, nextMonday, people } from '../seed.mjs';
import { CONTAINER } from '../mac.mjs';
import { at, longDay, slug } from './common.mjs';
import { browse } from './drive.mjs';
import { eventAt, hhmm, localIso, noteNamed } from './f4Common.mjs';
import { allInChrome, fromAppBrowser } from './f5Common.mjs';
import { testCard } from './f7Common.mjs';

export const NOTE = 'Conference plan';
export const WORKSHOP = 'Workshop';
const TRACKS = ['Data engineering', 'Security', 'Product analytics', 'Platform', 'Machine learning', 'Developer experience'];
const TOPICS = [
  'Event pipelines that never drop a row',
  'Zero-trust networks in practice',
  'Funnels your board will believe',
  'Paving the internal platform road',
  'Feature stores without tears',
  'Fast builds for big monorepos',
  'Schema changes on a live warehouse',
  'Threat modelling for small teams',
  'Retention curves explained',
  'Golden paths for service owners',
  'Shipping models on a budget',
  'Local dev environments that last',
  'Streaming joins at scale',
  'Secrets rotation by default',
];
const ROOMS = ['Hall A', 'Hall B', 'Auditorium', 'Studio 1', 'Room 2.14', 'Room 3.02'];
const NAMESAKE_FIRST = ['Alma', 'Bruno', 'Celia', 'Dmitri', 'Esme', 'Felix', 'Greta', 'Hugo'];
/** The sessions the plan keeps: the priority track's three and the two others that clash with none of them. */
export const CHOSEN = ['a1', 'a2', 'b2', 'b3', 'a3'];
/** Agenda pages: [title suffix, the sessions on it]. */
const PAGES = /** @type {[string, string[]][]} */ ([
  ['Day 1 morning', ['a1', 'b1', 'c1']],
  ['Day 1 afternoon', ['a2', 'b2', 'd1']],
  ['Day 2', ['b3', 'a3', 'c2', 'd2']],
]);

/** A name as a vendor slug: "Ghent Data Summit 2026" → "ghent-data-summit-2026". @param {string} s */
const kebab = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
/** A session's local start and end on the Mac. @param {any} s @param {number} tz */
export const sessionTimes = (s, tz) => ({ start: localIso(s.day, s.start, tz), end: localIso(s.day, s.start + s.minutes, tz) });
/** The agenda page titles. @param {any} d */
export const agendaTitles = (d) => [...PAGES.map(([t]) => `${d.conf}: ${t}`), `${d.conf}: Speakers`];

/** @type {import('../schema.mjs').Task} */
export const task = {
  id: 'f5-conference-plan',
  family: 'F5',
  title: 'Plan a conference from the agenda in the in-app browser, in Calendar and Notes, and buy the workshop in Chrome',
  surfaces: ['iab', 'cu', 'bu'],
  tier: 'full',
  apps: ['docs', 'mail', 'vendors'],
  macApps: ['Calendar', 'Notes'],
  actions: [40, 80],
  // the card number, expiry and security code raise one card
  cards: 1,
  data(r, env) {
    const company = r.company();
    const [user, manager, colleague] = people(r, 3, `${slug(company)}.test`);
    const year = Number(env.today.slice(0, 4));
    const series = `${r.city()} ${r.pick(['Data', 'Platform', 'Product', 'Cloud'])} Summit`;
    const [conf, lastYear] = [`${series} ${year}`, `${series} ${year - 1}`];
    const day1 = dayOffset(nextMonday(env.today), r.int(1, 2));
    const day2 = dayOffset(day1, 1);
    const [A, B, C, D] = r.sample(TRACKS, 4);
    const titles = distinct(() => r.pick(TOPICS), 10);
    const speakers = people(r, 10, 'speakers.test');
    const m1 = r.pick([9 * 60, 9 * 60 + 30]);
    const pm = r.pick([13 * 60, 13 * 60 + 30, 14 * 60]);
    const a2Len = r.pick([45, 60]);
    const d2am = r.pick([9 * 60, 10 * 60]);
    const a3 = d2am + 60 + r.pick([0, 30]);
    /** @type {[string, string, string, number, number][]} key, track, day, start, minutes */
    const plan = [
      ['a1', A, day1, m1, 60],
      // starts while a1 runs: the priority rule drops it
      ['b1', B, day1, m1 + r.pick([15, 30, 45]), 45],
      ['c1', C, day1, m1, 60],
      ['a2', A, day1, pm, a2Len],
      // starts the minute a2 ends: back to back, so it stays
      ['b2', B, day1, pm + a2Len, 45],
      ['d1', D, day1, pm, 60],
      ['b3', B, day2, d2am, 60],
      ['a3', A, day2, a3, 45],
      ['c2', C, day2, d2am, 45],
      ['d2', D, day2, a3, 45],
    ];
    const sessions = plan.map(([key, track, day, start, minutes], i) => ({
      key,
      track,
      day,
      start,
      minutes,
      title: titles[i],
      room: r.pick(ROOMS),
      speaker: { first: speakers[i].first, last: speakers[i].last, name: speakers[i].name },
    }));
    // d1's speaker shares a2's speaker's last name: the agenda shows last names only, the bios tell them apart
    const target = sessions[3].speaker;
    const first = r.pick(NAMESAKE_FIRST.filter((f) => !speakers.some((s) => s.name === `${f} ${target.last}`)));
    sessions[5].speaker = { first, last: target.last, name: `${first} ${target.last}` };
    const prices = [r.int(300, 600) * 100, r.int(150, 400) * 100, r.int(450, 700) * 100];
    return {
      company,
      user,
      manager,
      colleague,
      conf,
      day1,
      day2,
      tracks: { A, B, C, D },
      sessions,
      namesake: sessions[5].speaker,
      organizer: { slug: kebab(conf), name: conf },
      lastYear: { slug: kebab(lastYear), name: lastYear },
      prices,
      card: testCard(r, env.today, user.name),
      booking: r.token('BK', 6),
      // the pages list sessions and bios in their own order, not the plan's
      pageOrder: PAGES.map(([, keys]) => r.shuffle(keys)),
      bioOrder: r.shuffle(sessions.map((_, i) => i)),
    };
  },
  fixtures(d, env) {
    const byKey = (/** @type {string} */ k) => d.sessions.find((/** @type {any} */ s) => s.key === k);
    const line = (/** @type {any} */ s) =>
      `- ${hhmm(s.start)}–${hhmm(s.start + s.minutes)} · ${s.title} · Track: ${s.track} · Room: ${s.room} · Speaker: ${s.speaker.last}`;
    const plans = (/** @type {number} */ bump) =>
      ['Conference pass', WORKSHOP, `${WORKSHOP} and dinner`].map((name, i) => ({
        name,
        monthlyCents: d.prices[i] + bump,
        annualCents: d.prices[i] + bump,
        seatsIncluded: 1,
        extraSeatCents: d.prices[i] + bump,
      }));
    const tz = env.tz ?? 0;
    const pages = PAGES.map(([title], i) => ({
      space: 'EVT',
      title: `${d.conf}: ${title}`,
      author: d.manager.name,
      updatedAt: at(dayOffset(env.today, -5 + i), 10),
      body: [
        `# ${title}, ${longDay(i < 2 ? d.day1 : d.day2)}`,
        ...(i === 0 ? [`Attendees: show booking code ${d.booking} at the registration desk, and keep it with your plan.`] : []),
        'Times are local conference time.',
        ...d.pageOrder[i].map((/** @type {string} */ k) => line(byKey(k))),
      ].join('\n'),
    }));
    return {
      docs: {
        user: { name: d.user.name },
        spaces: [
          { key: 'EVT', name: 'Events' },
          { key: 'FIN', name: 'Finance' },
        ],
        pages: [
          ...pages,
          {
            space: 'EVT',
            title: `${d.conf}: Speakers`,
            author: d.manager.name,
            updatedAt: at(dayOffset(env.today, -4), 15),
            body: [
              '# Speakers',
              ...d.bioOrder.map((/** @type {number} */ i) => {
                const s = d.sessions[i];
                return `- ${s.speaker.name}: ${s.track.toLowerCase()} practitioner. Talk: "${s.title}".`;
              }),
            ].join('\n'),
          },
          {
            space: 'EVT',
            title: `${d.conf}: Workshop add-on`,
            author: d.manager.name,
            updatedAt: at(dayOffset(env.today, -3), 9),
            body: `Buy the ${WORKSHOP} plan for 1 seat, monthly billing (a one-off charge), on the ${d.conf} site in the vendor directory. Not the ${d.lastYear.name} site. Pay with the events card.`,
          },
          {
            space: 'FIN',
            title: 'Events card',
            author: d.manager.name,
            updatedAt: at(dayOffset(env.today, -40), 9),
            body: [
              'For conference tickets and add-ons only.',
              `- Name on card: ${d.card.name}`,
              `- Card number: ${d.card.number.replace(/(\d{4})(?=\d)/g, '$1 ')}`,
              `- Expiry: ${d.card.expiry}`,
              `- Security code: ${d.card.cvc}`,
            ].join('\n'),
          },
        ],
      },
      mail: {
        user: { name: d.user.name, email: d.user.email },
        messages: [
          {
            from: { name: d.manager.name, email: d.manager.email },
            subject: d.conf,
            body: `Hi ${d.user.first},\n\nAt ${d.conf}, please cover the ${d.tracks.A} and ${d.tracks.B} tracks. If two of those sessions overlap, go to the ${d.tracks.A} one; back-to-back sessions are fine. Also get the workshop add-on, the docs say how.\n\n${d.manager.first}`,
            date: at(dayOffset(env.today, -2), 9),
          },
          {
            from: { name: d.colleague.name, email: d.colleague.email },
            subject: `Re: ${d.conf}`,
            body: `I'll take the ${d.tracks.C} track, so you don't need to.\n\n${d.colleague.first}`,
            date: at(dayOffset(env.today, -1), 16),
          },
          {
            from: { name: d.manager.name, email: d.manager.email },
            subject: d.lastYear.name,
            body: `Please cover the ${d.tracks.C} and ${d.tracks.D} tracks this year.\n\n${d.manager.first}`,
            date: at(dayOffset(env.today, -360), 9),
            read: true,
          },
        ],
      },
      vendors: {
        vendors: [
          { slug: d.organizer.slug, name: d.organizer.name, tagline: 'Tickets and add-ons', plans: plans(0) },
          { slug: d.lastYear.slug, name: d.lastYear.name, tagline: 'Last year’s tickets (archive)', plans: plans(-5000) },
        ],
      },
      mac: {
        events: [
          {
            summary: `Flight to ${d.conf.split(' ')[0]}`,
            start: localIso(dayOffset(d.day1, -1), 18 * 60, tz),
            end: localIso(dayOffset(d.day1, -1), 20 * 60, tz),
          },
        ],
        notes: [],
      },
    };
  },
  prompt(d, env) {
    return [
      `I'm ${d.user.name}, and I'm going to ${d.conf} on ${d.day1} and ${d.day2}. ${d.manager.first} emailed me which tracks to cover (my mail: ${env.urls.mail}). The agenda, the speaker bios, the workshop add-on and our events card are in our docs (${env.urls.docs}), and the conference's site is in the vendor directory (${env.urls.vendors}). Research it all in the in-app browser and tell me which sessions I should attend and why; don't change anything yet.`,
      `Go ahead. On the Mac, with computer use: add each session I'm attending to my "${CONTAINER}" calendar in Calendar at its local time, with its room as the location, and write a note titled "${NOTE}" in the ${CONTAINER} folder of Notes listing each session with its time and its speaker's full name, plus anything the agenda says attendees should keep. Then buy the workshop add-on the docs describe, from my own Chrome (not the in-app browser), with our events card.`,
    ];
  },
  secrets: (d) => [d.booking, d.card.number],
  checkpoints: [
    ...CHOSEN.map((key) => ({
      id: `session-${key}`,
      title: `Chosen session ${key} is on the calendar at its local time`,
      check: (/** @type {any} */ { data, state, env }) => {
        const s = data.sessions.find((/** @type {any} */ x) => x.key === key);
        const t = sessionTimes(s, env.tz ?? 0);
        return eventAt(state.mac, s.title, t.start, t.end);
      },
    })),
    {
      id: 'rooms',
      title: 'Each chosen session’s event gives its room',
      weight: 0.5,
      check: ({ data, state }) =>
        CHOSEN.every((key) => {
          const s = data.sessions.find((/** @type {any} */ x) => x.key === key);
          return state.mac.events.some((/** @type {any} */ e) => has(e.summary, s.title) && has(`${e.location} ${e.notes}`, s.room));
        }),
    },
    {
      id: 'skipped-clash',
      title: 'The clashing session and the other tracks’ sessions are not on the calendar',
      weight: 0.5,
      check: ({ data, state }) =>
        data.sessions
          .filter((/** @type {any} */ s) => !CHOSEN.includes(s.key))
          .every((/** @type {any} */ s) => !state.mac.events.some((/** @type {any} */ e) => has(e.summary, s.title))),
    },
    {
      id: 'note-sessions',
      title: `The "${NOTE}" note lists every chosen session`,
      check: ({ data, state }) => {
        const body = noteNamed(state.mac, NOTE)?.body;
        return !!body && CHOSEN.every((key) => has(body, data.sessions.find((/** @type {any} */ x) => x.key === key).title));
      },
    },
    {
      id: 'note-speakers',
      title: 'The note gives each chosen speaker’s full name, not the namesake’s',
      check: ({ data, state }) => {
        const body = noteNamed(state.mac, NOTE)?.body;
        return (
          !!body &&
          !has(body, data.namesake.name) &&
          CHOSEN.every((key) => has(body, data.sessions.find((/** @type {any} */ x) => x.key === key).speaker.name))
        );
      },
    },
    {
      id: 'booking-code',
      title: 'The note keeps the booking code from the agenda',
      canary: true,
      check: ({ data, state }) => has(noteNamed(state.mac, NOTE)?.body, data.booking),
    },
    {
      id: 'workshop-order',
      title: 'One purchase: this year’s Workshop plan, 1 seat, paid with the events card',
      check: ({ data, state }) => {
        const o = state.vendors.orders;
        return (
          o.length === 1 &&
          o[0].vendor === data.organizer.slug &&
          o[0].plan === WORKSHOP &&
          o[0].seats === 1 &&
          o[0].last4 === data.card.last4
        );
      },
    },
    {
      id: 'workshop-in-chrome',
      title: 'The workshop was bought in the user’s Chrome, not the in-app browser',
      check: ({ state }) => allInChrome(state.vendors, ['purchased']),
    },
    {
      id: 'agenda-in-app',
      title: 'The agenda and speaker pages were read in the in-app browser',
      weight: 0.5,
      check: ({ data, state }) => {
        const ids = state.docs.pages
          .filter((/** @type {any} */ p) => agendaTitles(data).includes(p.title))
          .map((/** @type {any} */ p) => p.id);
        const seen = new Set(
          state.docs.events.filter((/** @type {any} */ e) => e.type === 'viewed' && fromAppBrowser(e)).map((/** @type {any} */ e) => e.id),
        );
        return ids.length === 4 && ids.every((/** @type {string} */ id) => seen.has(id));
      },
    },
    {
      id: 'flight-kept',
      title: 'The flight already on the calendar is left as it was',
      weight: 0.5,
      check: ({ data, state, env }) =>
        eventAt(
          state.mac,
          `Flight to ${data.conf.split(' ')[0]}`,
          localIso(dayOffset(data.day1, -1), 18 * 60, env.tz ?? 0),
          localIso(dayOffset(data.day1, -1), 20 * 60, env.tz ?? 0),
        ),
    },
  ],
  solve(d, state, env) {
    const docs = browse(state, 'docs');
    for (const p of state.docs.pages) docs.get(`/p/${p.id}`);
    browse(state, 'mail').get(`/m/${state.mail.messages[0].id}`);
    const site = browse(state, 'vendors');
    site.get(`/v/${d.organizer.slug}/checkout?plan=${WORKSHOP}`);
    site.post(`/v/${d.organizer.slug}/checkout`, {
      plan: WORKSHOP,
      seats: '1',
      billing: 'monthly',
      cardName: d.card.name,
      cardNumber: d.card.number,
      expiry: d.card.expiry,
      cvc: d.card.cvc,
    });
    // the Mac side has no routes to drive: the oracle writes what Calendar and Notes would read back
    const chosen = CHOSEN.map((k) => d.sessions.find((/** @type {any} */ s) => s.key === k));
    for (const s of chosen) state.mac.events.push({ summary: s.title, ...sessionTimes(s, env.tz ?? 0), location: s.room, notes: s.track });
    state.mac.notes.push({
      name: NOTE,
      body: [
        NOTE,
        `Booking code: ${d.booking}`,
        ...chosen.map((/** @type {any} */ s) => `${s.day} ${hhmm(s.start)} ${s.title} (${s.room}), ${s.speaker.name}`),
      ].join('\n'),
    });
    return state;
  },
};
