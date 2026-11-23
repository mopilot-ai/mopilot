// MGB task f4-week-plan (#1381, F4): build next week's plan on the Mac from a spreadsheet: calendar events with
// travel buffers, prep reminders, a Notes summary with the meeting links, and a clashing 1:1 moved by the sheet's rule.
import { has, same } from '../grade.mjs';
import { dayOffset, distinct, nextMonday, people } from '../seed.mjs';
import { toCsv } from '../files.mjs';
import { CONTAINER, overlaps } from '../mac.mjs';
import { localIso } from './f4Common.mjs';

export { localIso };
const OFFICE = 'Office';
const SHEET = 'next-week.csv';
const hhmm = (/** @type {number} */ m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

/** @type {import('../schema.mjs').Task} */
export const task = {
  id: 'f4-week-plan',
  family: 'F4',
  title: 'Plan next week on the Mac from a spreadsheet, with travel buffers, prep reminders and a moved 1:1',
  surfaces: ['cu'],
  tier: 'smoke',
  apps: [],
  macApps: ['Calendar', 'Reminders', 'Notes'],
  actions: [30, 80],
  cards: { min: 0, max: 4 },
  data(r, env) {
    const monday = nextMonday(env.today);
    const [user, manager] = people(r, 2, 'copperleaf.test');
    const titles = distinct(
      () =>
        `${r.pick(['Design review', 'Quarterly planning', 'Supplier visit', 'Budget sync', 'Customer workshop', 'Hiring panel', 'Roadmap review'])} with ${r.company()}`,
      5,
    );
    const days = [0, 1, 1, 3, 4];
    const meetings = titles.map((title, i) => {
      const start = (9 + r.int(0, 6)) * 60 + r.pick([0, 30]);
      const offsite = i % 2 === 0;
      return {
        title,
        day: dayOffset(monday, days[i]),
        weekday: WEEKDAYS[days[i]],
        start: i === 2 ? Math.max(start, 14 * 60) : i === 1 ? Math.min(start, 11 * 60) : start,
        minutes: r.pick([30, 45, 60, 90]),
        location: offsite ? `${r.int(10, 99)} ${r.pick(['Harbour St', 'Mill Lane', 'Station Rd', 'Quay Ave'])}, ${r.city()}` : OFFICE,
        link: `https://meet.example.test/${r.token('m', 7).slice(2).toLowerCase()}`,
        prep:
          i < 3
            ? `Read the ${r.pick(['brief', 'deck', 'contract draft', 'budget sheet'])} for ${title.split(' with ')[0].toLowerCase()}`
            : '',
      };
    });
    // the 1:1 clashes with the Tuesday morning meeting; the rule moves it to the first free whole hour that day
    const clash = meetings[1];
    const oneOnOne = { title: `1:1 with ${manager.first}`, day: clash.day, start: clash.start, minutes: 30 };
    const busy = meetings
      .filter((m) => m.day === clash.day)
      .flatMap((m) => [
        { start: m.start, end: m.start + m.minutes },
        ...(m.location === OFFICE ? [] : [{ start: m.start - 30, end: m.start }]),
      ]);
    let moved = 9 * 60;
    while (busy.some((b) => moved < b.end && b.start < moved + oneOnOne.minutes)) moved += 60;
    return { user, manager, monday, meetings, oneOnOne, movedTo: moved, agendaCode: r.canary() };
  },
  fixtures(d, env) {
    const rows = [
      ['Day', 'Date', 'Start', 'End', 'Meeting', 'Location', 'Link', 'Prep'],
      ...d.meetings.map((/** @type {any} */ m) => [
        m.weekday,
        m.day,
        hhmm(m.start),
        hhmm(m.start + m.minutes),
        m.title,
        m.location,
        m.link,
        m.prep,
      ]),
      [],
      ['Notes', `Agenda code for the week: ${d.agendaCode}`],
      ['', `If my 1:1 with ${d.manager.first} clashes with anything, move it to the first free whole hour from 09:00 that day.`],
      ['', 'Anything not at the Office needs 30 minutes of travel blocked right before it.'],
    ];
    const tz = env.tz ?? 0;
    return {
      files: { entries: { [SHEET]: { text: toCsv(rows) } } },
      mac: {
        events: [
          {
            summary: d.oneOnOne.title,
            start: localIso(d.oneOnOne.day, d.oneOnOne.start, tz),
            end: localIso(d.oneOnOne.day, d.oneOnOne.start + d.oneOnOne.minutes, tz),
            location: OFFICE,
          },
          // Wednesday has no meetings: the lunch never clashes with the week's plan
          {
            summary: 'Team lunch',
            start: localIso(dayOffset(d.monday, 2), 12 * 60 + 30, tz),
            end: localIso(dayOffset(d.monday, 2), 13 * 60 + 30, tz),
          },
        ],
        reminders: [{ name: 'Renew parking permit', due: localIso(dayOffset(d.monday, -3), 17 * 60, tz) }],
        notes: [],
      },
    };
  },
  prompt(d, env) {
    return [
      `I'm ${d.user.name}. My plan for next week is in the spreadsheet ${SHEET} in ${env.files}. Open it with computer use and tell me what's in it. Don't change anything yet.`,
      `Now set the week up in my "${CONTAINER}" calendar, reminder list and notes folder: one Calendar event per meeting (with its location and link), the travel and clash rules from the sheet's notes, a reminder for each prep item due at 17:00 the day before its meeting, and a note titled "Week of ${d.monday}" listing every meeting with its day, time and link, plus anything the sheet says the week's notes need.`,
    ];
  },
  secrets: (d) => [d.agendaCode],
  checkpoints: [
    ...[0, 1, 2, 3, 4].flatMap((k) => [
      {
        id: `meeting-${k}`,
        title: `Meeting ${k + 1} is on the calendar at its time`,
        check: (/** @type {any} */ { data, state, env }) => {
          const m = data.meetings[k];
          return state.mac.events.some(
            (/** @type {any} */ e) =>
              has(e.summary, m.title) &&
              e.start === localIso(m.day, m.start, env.tz ?? 0) &&
              e.end === localIso(m.day, m.start + m.minutes, env.tz ?? 0),
          );
        },
      },
      {
        id: `meeting-${k}-where`,
        title: `Meeting ${k + 1} has its location and link`,
        weight: 0.5,
        check: (/** @type {any} */ { data, state }) => {
          const m = data.meetings[k];
          return state.mac.events.some(
            (/** @type {any} */ e) =>
              has(e.summary, m.title) && has(e.location, m.location.split(',')[0]) && has(`${e.notes} ${e.location} ${e.url}`, m.link),
          );
        },
      },
    ]),
    {
      id: 'travel',
      title: 'Every off-site meeting has 30 minutes of travel right before it',
      check: ({ data, state, env }) =>
        data.meetings
          .filter((/** @type {any} */ m) => m.location !== OFFICE)
          .every((/** @type {any} */ m) =>
            state.mac.events.some(
              (/** @type {any} */ e) =>
                /travel/i.test(e.summary) &&
                e.end === localIso(m.day, m.start, env.tz ?? 0) &&
                e.start === localIso(m.day, m.start - 30, env.tz ?? 0),
            ),
          ),
    },
    {
      id: 'no-office-travel',
      title: 'No travel is blocked before an office meeting',
      weight: 0.5,
      check: ({ data, state, env }) =>
        data.meetings
          .filter((/** @type {any} */ m) => m.location === OFFICE)
          .every(
            (/** @type {any} */ m) =>
              !state.mac.events.some(
                (/** @type {any} */ e) => /travel/i.test(e.summary) && e.end === localIso(m.day, m.start, env.tz ?? 0),
              ),
          ),
    },
    {
      id: 'one-on-one',
      title: 'The 1:1 moved to the first free hour that day, once',
      check: ({ data, state, env }) => {
        const all = state.mac.events.filter((/** @type {any} */ e) => same(e.summary, data.oneOnOne.title));
        return all.length === 1 && all[0].start === localIso(data.oneOnOne.day, data.movedTo, env.tz ?? 0);
      },
    },
    {
      id: 'no-clash',
      title: 'Nothing on the calendar overlaps anything else that week',
      weight: 0.5,
      check: ({ state }) =>
        state.mac.events.every((/** @type {any} */ a, /** @type {number} */ i) =>
          state.mac.events.every((/** @type {any} */ b, /** @type {number} */ j) => i === j || !overlaps(a, b)),
        ),
    },
    {
      id: 'reminders',
      title: 'A reminder per prep item, due 17:00 the day before its meeting',
      check: ({ data, state, env }) =>
        data.meetings
          .filter((/** @type {any} */ m) => m.prep)
          .every((/** @type {any} */ m) =>
            state.mac.reminders.some(
              (/** @type {any} */ x) =>
                x.list === CONTAINER &&
                has(x.name, m.prep.split(' for ')[0]) &&
                x.due === localIso(dayOffset(m.day, -1), 17 * 60, env.tz ?? 0),
            ),
          ),
    },
    {
      id: 'note',
      title: 'The week note lists every meeting with its link',
      check: ({ data, state }) => {
        const note = state.mac.notes.find((/** @type {any} */ n) => has(n.name, `Week of ${data.monday}`));
        return !!note && data.meetings.every((/** @type {any} */ m) => has(note.body, m.title) && has(note.body, m.link));
      },
    },
    {
      id: 'agenda-code',
      title: 'The week note carries the agenda code',
      canary: true,
      check: ({ data, state }) => state.mac.notes.some((/** @type {any} */ n) => has(n.body, data.agendaCode)),
    },
    {
      id: 'others-kept',
      title: 'Team lunch and the parking reminder are left as they were',
      weight: 0.5,
      check: ({ state }) =>
        state.mac.events.some((/** @type {any} */ e) => e.summary === 'Team lunch') &&
        state.mac.reminders.some((/** @type {any} */ x) => x.name === 'Renew parking permit' && !x.completed),
    },
  ],
  solve(d, state, env) {
    // the Mac side has no routes to drive: the oracle writes what Calendar, Reminders and Notes would read back
    const tz = env.tz ?? 0;
    const mac = state.mac;
    for (const m of d.meetings) {
      mac.events.push({
        summary: m.title,
        start: localIso(m.day, m.start, tz),
        end: localIso(m.day, m.start + m.minutes, tz),
        location: m.location,
        notes: m.link,
      });
      if (m.location !== OFFICE)
        mac.events.push({
          summary: `Travel to ${m.location.split(',')[0]}`,
          start: localIso(m.day, m.start - 30, tz),
          end: localIso(m.day, m.start, tz),
          location: '',
          notes: '',
        });
      if (m.prep)
        mac.reminders.push({
          list: CONTAINER,
          name: m.prep,
          due: localIso(dayOffset(m.day, -1), 17 * 60, tz),
          completed: false,
          notes: '',
        });
    }
    const one = mac.events.find((/** @type {any} */ e) => e.summary === d.oneOnOne.title);
    one.start = localIso(d.oneOnOne.day, d.movedTo, tz);
    one.end = localIso(d.oneOnOne.day, d.movedTo + d.oneOnOne.minutes, tz);
    mac.notes.push({
      name: `Week of ${d.monday}`,
      body: `Week of ${d.monday}\nAgenda code: ${d.agendaCode}\n${d.meetings.map((/** @type {any} */ m) => `${m.weekday} ${hhmm(m.start)} ${m.title} ${m.link}`).join('\n')}`,
    });
    return state;
  },
};
