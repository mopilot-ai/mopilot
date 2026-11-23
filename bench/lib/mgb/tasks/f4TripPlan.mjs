// MGB task f4-trip-plan (#1381, F4): turn a messy Notes itinerary into Calendar events (flights, an airport block,
// meetings), missing packing reminders, a filled budget row in a CSV sheet and a Notes trip summary, past a cancelled flight
// and a moved meeting.
import { has } from '../grade.mjs';
import { csvRows, describeFile, toCsv } from '../files.mjs';
import { CONTAINER, listName } from '../mac.mjs';
import { dayOffset, distinct, nextMonday, parseMoney, people } from '../seed.mjs';
import { eventAt, hhmm, localIso, noteNamed, remindersIn, weekday } from './f4Common.mjs';

const PACK = listName('Packing');
const BUDGET = 'trip-budget.csv';
const ITEMS = [
  'Passport',
  'Phone charger',
  'Travel adapter',
  'Rain jacket',
  'Business cards',
  'Laptop stand',
  'Headphones',
  'Toiletry bag',
  'Running shoes',
  'Umbrella',
  'Spare shirts',
  'Presentation clicker',
  'Sunglasses',
  'Notebook',
];
const HOTELS = ['Hotel Azure Quay', 'The Linden House', 'Harbourlight Inn', 'Hotel Meridian Court', 'The Saltworks Hotel'];
const STREETS = ['Harbour St', 'Mill Lane', 'Station Rd', 'Quay Ave', 'Rope Walk', 'Market Sq'];

/** A flight number compared without spaces: "MG 1452", "MG1452" and "mg 1452" are one flight. @param {unknown} s */
const squash = (s) => String(s).toLowerCase().replace(/\s+/g, '');
/** @param {any} f */
const flightLine = (f) => `${f.number}  ${weekday(f.day).slice(0, 3)} ${f.day}  dep ${hhmm(f.dep)} arr ${hhmm(f.arr)}`;
/** Whether an event is this flight, departure to arrival. @param {any} mac @param {any} f @param {number} tz */
const flightBooked = (mac, f, tz) =>
  mac.events.some(
    (/** @type {any} */ e) =>
      squash(e.summary).includes(squash(f.number)) && e.start === localIso(f.day, f.dep, tz) && e.end === localIso(f.day, f.arr, tz),
  );
/** Whether an event is this meeting, at its time and address. @param {any} mac @param {any} m @param {number} tz */
const meetingBooked = (mac, m, tz) =>
  mac.events.some(
    (/** @type {any} */ e) =>
      has(e.summary, m.company) &&
      e.start === localIso(m.day, m.start, tz) &&
      e.end === localIso(m.day, m.start + m.minutes, tz) &&
      has(`${e.location} ${e.notes}`, m.address.split(',')[0]),
  );
/** The budget sheet's rows as the agent left the file in the task folder. @param {any} state */
const budgetRows = (state) => csvRows(state.files.entries[BUDGET]?.text);
/** The trip row's cell under `column`, in cents (null when it is not an amount; a missing row throws, so it is unmet). @param {any} state @param {any} d @param {string} column */
function budgetCell(state, d, column) {
  const rows = budgetRows(state);
  const header = rows.find((r) => r[0] === 'Trip');
  const row = rows.find((r) => has(r[0], d.tripLabel));
  if (!header || !row) throw new Error(`${BUDGET} has no trip row under its header`);
  return parseMoney(row[header.indexOf(column)]);
}

/** @type {import('../schema.mjs').Task} */
export const task = {
  id: 'f4-trip-plan',
  family: 'F4',
  title: 'Plan a business trip on the Mac from a messy Notes itinerary: flights, meetings, packing, budget and a summary',
  surfaces: ['cu'],
  tier: 'full',
  apps: [],
  macApps: ['Notes', 'Calendar', 'Reminders'],
  actions: [35, 80],
  cards: { min: 0, max: 4 },
  data(r, env) {
    const monday = nextMonday(env.today);
    const [user, contactA, contactB] = people(r, 3, 'example.test');
    const cities = distinct(() => r.city(), 4);
    const city = cities[0];
    const airline = r.pick(['MG', 'QV', 'ZK', 'BX']);
    const numbers = distinct(() => `${airline} ${r.int(100, 9899)}`, 3);
    const o = r.int(0, 1);
    const outDay = dayOffset(monday, o);
    const backDay = dayOffset(monday, 4);
    const outDep = r.int(108, 156) * 5;
    const outMinutes = r.int(18, 48) * 5;
    const backDep = r.int(180, 216) * 5;
    const cancelDep = outDep - r.int(24, 36) * 5;
    const outbound = { number: numbers[0], day: outDay, dep: outDep, arr: outDep + outMinutes };
    const cancelled = { number: numbers[1], day: outDay, dep: cancelDep, arr: cancelDep + outMinutes };
    const back = { number: numbers[2], day: backDay, dep: backDep, arr: backDep + outMinutes + r.int(-2, 2) * 5 };
    const nights = 4 - o;
    const rates = cities.map((c) => ({ city: c, hotel: r.int(24, 52) * 5, meals: r.int(9, 19) * 5 }));
    const [coA, coB] = distinct(() => r.company(), 2);
    const [stA, stB] = r.sample(STREETS, 2);
    const meetings = [
      {
        company: coA,
        contact: contactA,
        day: dayOffset(monday, 2),
        start: r.int(18, 22) * 30,
        minutes: r.pick([60, 90]),
        address: `${r.int(2, 98)} ${stA}, ${city}`,
      },
      // booked for Wednesday afternoon in the note, then moved to Thursday
      {
        company: coB,
        contact: contactB,
        was: dayOffset(monday, 2),
        day: dayOffset(monday, 3),
        start: r.int(28, 31) * 30,
        minutes: 60,
        address: `${r.int(2, 98)} ${stB}, ${city}`,
      },
    ];
    const items = r.sample(ITEMS, 8);
    return {
      user,
      city,
      outbound,
      cancelled,
      back,
      hotel: { name: r.pick(HOTELS), checkIn: outDay, checkOut: backDay, code: r.canary() },
      nights,
      days: nights + 1,
      rates,
      tripLabel: `${city} ${outDay}`,
      meetings,
      packing: { ticked: items.slice(0, 2), open: items[2], missing: items.slice(3, 7), extra: items[7] },
    };
  },
  fixtures(d, env) {
    const tz = env.tz ?? 0;
    const [a, b] = d.meetings;
    const p = d.packing;
    const body = [
      '(all times local)',
      '',
      'FLIGHTS',
      `${flightLine(d.cancelled)}   CANCELLED by the airline, rebooked on the next one`,
      `${flightLine(d.outbound)}   outbound`,
      `${flightLine(d.back)}   return`,
      '',
      'HOTEL',
      `${d.hotel.name}, in ${d.hotel.checkIn}, out ${d.hotel.checkOut}. Confirmation: ${d.hotel.code}`,
      '',
      'CLIENT MEETINGS',
      `1) ${weekday(a.day)} ${a.day} ${hhmm(a.start)}-${hhmm(a.start + a.minutes)}, ${a.company} (${a.contact.name}), ${a.address}`,
      `2) ${weekday(b.was)} ${b.was} ${hhmm(b.start)}-${hhmm(b.start + b.minutes)}, ${b.company} (${b.contact.name}), ${b.address}`,
      `   ${b.contact.first} wrote: moved to Thursday ${b.day}, same time and place.`,
      '',
      'PACKING',
      [...p.ticked, p.open, ...p.missing].map((x) => x.toLowerCase()).join(', '),
    ].join('\n');
    const rows = [
      ['City', 'Hotel per night', 'Meals per day'],
      ...[...d.rates].sort((x, y) => x.city.localeCompare(y.city)).map((x) => [x.city, `$${x.hotel}`, `$${x.meals}`]),
      [],
      ['Trip', 'Nights', 'Days', 'Hotel', 'Meals', 'Total'],
      [d.tripLabel, '', '', '', '', ''],
      [],
      [
        'How to fill',
        'Hotel = nights x the city hotel rate. Meals = days away (both travel days count) x the city meals rate. Total = Hotel + Meals. Type values, not formulas.',
      ],
    ];
    return {
      files: { entries: { [BUDGET]: { text: toCsv(rows) } } },
      mac: {
        notes: [{ name: `Trip: ${d.city}`, body }],
        reminders: [
          ...p.ticked.map((/** @type {string} */ name) => ({ list: 'Packing', name, completed: true })),
          { list: 'Packing', name: p.open },
          { list: 'Packing', name: p.extra },
        ],
        events: [
          {
            summary: 'Dentist',
            start: localIso(dayOffset(d.outbound.day, -3), 8 * 60, tz),
            end: localIso(dayOffset(d.outbound.day, -3), 9 * 60, tz),
          },
        ],
      },
    };
  },
  prompt(d, env) {
    return [
      `I'm ${d.user.name}. My trip to ${d.city} is sketched in the note "Trip: ${d.city}" in my "${CONTAINER}" notes folder, my "${PACK}" reminders list has what I've packed so far, and ${BUDGET} in ${env.files} has the per-diem rates. Look at all three with computer use and tell me what the trip looks like. Don't change anything yet.`,
      `Now set the trip up. In my "${CONTAINER}" calendar: one event per flight I'm actually taking (flight number in the title, from departure to arrival), a 2-hour "Airport" block right before the outbound flight, and one event per client meeting at its final time with its address. In "${PACK}": a reminder for each packing item from the note that isn't on the list yet, without repeating anything already there. In ${BUDGET}: fill the trip row as the sheet says, and keep it a CSV file. Last, a note "Trip summary ${d.city}" in the "${CONTAINER}" folder with both flights, the hotel and its confirmation.`,
    ];
  },
  secrets: (d) => [d.hotel.code],
  checkpoints: [
    {
      id: 'flight-out',
      title: 'The outbound flight is on the calendar from departure to arrival',
      check: ({ data, state, env }) => flightBooked(state.mac, data.outbound, env.tz ?? 0),
    },
    {
      id: 'flight-back',
      title: 'The return flight is on the calendar from departure to arrival',
      check: ({ data, state, env }) => flightBooked(state.mac, data.back, env.tz ?? 0),
    },
    {
      id: 'no-cancelled',
      title: 'The cancelled flight is not on the calendar',
      weight: 0.5,
      check: ({ data, state }) =>
        !state.mac.events.some((/** @type {any} */ e) => squash(e.summary).includes(squash(data.cancelled.number))),
    },
    {
      id: 'airport',
      title: 'A 2-hour Airport block ends at the outbound departure',
      check: ({ data, state, env }) => {
        const f = data.outbound;
        return eventAt(state.mac, 'Airport', localIso(f.day, f.dep - 120, env.tz ?? 0), localIso(f.day, f.dep, env.tz ?? 0));
      },
    },
    {
      id: 'meeting-0',
      title: 'The first client meeting is on the calendar at its time and address',
      check: ({ data, state, env }) => meetingBooked(state.mac, data.meetings[0], env.tz ?? 0),
    },
    {
      id: 'meeting-moved',
      title: 'The moved meeting is on Thursday, once, and not on its old day',
      check: ({ data, state, env }) => {
        const m = data.meetings[1];
        return (
          meetingBooked(state.mac, m, env.tz ?? 0) &&
          state.mac.events.filter((/** @type {any} */ e) => has(e.summary, m.company)).length === 1
        );
      },
    },
    {
      id: 'packing-added',
      title: 'Every packing item not yet on the list has an open reminder',
      check: ({ data, state }) =>
        data.packing.missing.every((/** @type {string} */ item) =>
          remindersIn(state.mac, PACK, item).some((/** @type {any} */ x) => !x.completed),
        ),
    },
    {
      id: 'packing-no-dupes',
      title: 'No packing item is on the list twice, and ticked items stay ticked',
      weight: 0.5,
      check: ({ data, state }) => {
        const p = data.packing;
        return (
          [...p.ticked, p.open, ...p.missing, p.extra].every((item) => remindersIn(state.mac, PACK, item).length <= 1) &&
          p.ticked.every((/** @type {string} */ item) => remindersIn(state.mac, PACK, item).some((/** @type {any} */ x) => x.completed))
        );
      },
    },
    {
      id: 'budget-hotel',
      title: "The budget's Hotel cell is nights times the city's hotel rate",
      check: ({ data, state }) => budgetCell(state, data, 'Hotel') === data.nights * data.rates[0].hotel * 100,
    },
    {
      id: 'budget-meals',
      title: "The budget's Meals cell is days away times the city's meals rate",
      check: ({ data, state }) => budgetCell(state, data, 'Meals') === data.days * data.rates[0].meals * 100,
    },
    {
      id: 'budget-total',
      title: "The budget's Total cell is the trip's hotel plus meals",
      check: ({ data, state }) =>
        budgetCell(state, data, 'Total') === (data.nights * data.rates[0].hotel + data.days * data.rates[0].meals) * 100,
    },
    {
      id: 'summary',
      title: 'The trip summary note lists both flights and the hotel',
      check: ({ data, state }) => {
        const n = noteNamed(state.mac, `Trip summary ${data.city}`);
        return !!n && [data.outbound, data.back].every((f) => squash(n.body).includes(squash(f.number))) && has(n.body, data.hotel.name);
      },
    },
    {
      id: 'confirmation',
      title: "The trip summary note carries the hotel's confirmation code",
      canary: true,
      check: ({ data, state }) => has(noteNamed(state.mac, `Trip summary ${data.city}`)?.body, data.hotel.code),
    },
    {
      id: 'itinerary-kept',
      title: 'The itinerary note and the dentist appointment are left as they were',
      weight: 0.5,
      check: ({ data, state }) =>
        has(noteNamed(state.mac, `Trip: ${data.city}`)?.body, data.hotel.code) &&
        state.mac.events.some((/** @type {any} */ e) => e.summary === 'Dentist'),
    },
  ],
  solve(d, state, env) {
    // the Mac side has no routes to drive: the oracle writes what Calendar, Reminders and Notes would read back, and the
    // budget sheet as an editor would save it
    const tz = env.tz ?? 0;
    const mac = state.mac;
    for (const f of [d.outbound, d.back])
      mac.events.push({
        summary: `Flight ${f.number}`,
        start: localIso(f.day, f.dep, tz),
        end: localIso(f.day, f.arr, tz),
        location: '',
        notes: '',
      });
    const f = d.outbound;
    mac.events.push({
      summary: 'Airport',
      start: localIso(f.day, f.dep - 120, tz),
      end: localIso(f.day, f.dep, tz),
      location: '',
      notes: '',
    });
    for (const m of d.meetings)
      mac.events.push({
        summary: `${m.company} with ${m.contact.name}`,
        start: localIso(m.day, m.start, tz),
        end: localIso(m.day, m.start + m.minutes, tz),
        location: m.address,
        notes: '',
      });
    for (const name of d.packing.missing) mac.reminders.push({ list: PACK, name, due: null, completed: false, notes: '' });
    const rates = d.rates[0];
    const sheet = budgetRows(state);
    // the seeded sheet always has the trip row
    const row = /** @type {string[]} */ (sheet.find((r) => r[0] === d.tripLabel));
    row.splice(
      1,
      5,
      String(d.nights),
      String(d.days),
      `$${d.nights * rates.hotel}`,
      `$${d.days * rates.meals}`,
      `$${d.nights * rates.hotel + d.days * rates.meals}`,
    );
    state.files.entries[BUDGET] = describeFile(BUDGET, Buffer.from(toCsv(sheet)));
    mac.notes.push({
      name: `Trip summary ${d.city}`,
      body: `Trip summary ${d.city}\n${flightLine(d.outbound)}\n${flightLine(d.back)}\n${d.hotel.name}, confirmation ${d.hotel.code}`,
    });
    return state;
  },
};
