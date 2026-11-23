// MGB task f4-reminder-triage (#1381, F4): triage the bench reminder list by the rules in a note: complete what was
// done in a ticket, move overdue #waiting items to another list, reschedule overdue #work items, and block a Calendar
// focus slot for the top three open items.
import { has } from '../grade.mjs';
import { CONTAINER, listName } from '../mac.mjs';
import { dayOffset, distinct, people } from '../seed.mjs';
import { localIso, nextWeekday, remindersIn } from './f4Common.mjs';

const WAITING = listName('Waiting');
const HIGH = 'priority: high';
const WORK = [
  'Send the forecast to',
  'Review the contract for',
  'Draft the proposal for',
  'Prepare the demo for',
  'Update the price list for',
];
const WAIT = ['Signed NDA from', 'Feedback on the brief from', 'Revised quote from', 'Delivery date from'];
const HOME = [
  'Book a dentist appointment',
  'Renew the library card',
  'Fix the bike light',
  'Order printer ink',
  'Return the parcel',
  'Water the balcony plants',
  'Replace the smoke alarm battery',
  'Collect the dry cleaning',
];

/** A focus event: the one whose title starts with "Focus". @param {any} mac */
const focusEvents = (mac) => mac.events.filter((/** @type {any} */ e) => /^\s*focus\b/i.test(e.summary));

/** @type {import('../schema.mjs').Task} */
export const task = {
  id: 'f4-reminder-triage',
  family: 'F4',
  title: 'Triage a Reminders list on the Mac by the rules in a note: complete, move, reschedule, and block focus time',
  surfaces: ['cu'],
  tier: 'full',
  apps: [],
  macApps: ['Notes', 'Reminders', 'Calendar'],
  actions: [25, 70],
  cards: { min: 0, max: 4 },
  data(r, env) {
    const [user] = people(r, 1, 'example.test');
    const ticket = () => `OPS-${r.int(1000, 9999)}`;
    const work = distinct(() => `${r.pick(WORK)} ${r.company()}`, 8);
    const wait = distinct(() => `${r.pick(WAIT)} ${r.company()}`, 3);
    const home = r.sample(HOME, 5);
    const past = () => ({ day: dayOffset(env.today, -r.int(1, 6)), at: r.int(9, 17) * 60 });
    const later = () => ({ day: dayOffset(env.today, r.int(2, 8)), at: r.int(9, 17) * 60 });
    /** @param {string} name @param {string} kind @param {{ day: string, at: number }} due @param {string} notes */
    const item = (name, kind, due, notes) => ({ name, kind, ...due, notes });
    const items = [
      item(work[0], 'reschedule', past(), `#work ${HIGH}`),
      item(work[1], 'reschedule', past(), '#work'),
      item(work[2], 'reschedule', past(), '#work Waiting on finance to sign off.'),
      // overdue #work, but done: rule 1 handles it, so rule 3 leaves it alone
      item(work[3], 'done', past(), `#work Done in ${ticket()}.`),
      item(work[4], 'keep', later(), `#work ${HIGH}`),
      item(work[5], 'keep', later(), '#work'),
      item(work[6], 'done', later(), `#work ${HIGH} Done in ${ticket()}, nothing left.`),
      item(wait[0], 'move', past(), '#waiting Asked twice already.'),
      item(wait[1], 'move', past(), '#waiting'),
      item(wait[2], 'keep', later(), '#waiting'),
      item(home[0], 'done', later(), `#home done in ${ticket()}`),
      // "done in" without a ticket: not done
      item(home[1], 'keep', past(), '#home Must be done in person at the town hall.'),
      item(home[2], 'keep', past(), '#home'),
      item(home[3], 'keep', later(), `#home ${HIGH}`),
      item(home[4], 'keep', later(), '#home'),
    ];
    return {
      user,
      items: r.shuffle(items),
      top: [work[0], work[4], home[3]],
      doneHigh: work[6],
      tomorrow: dayOffset(env.today, 1),
      next: nextWeekday(env.today),
      focusCode: r.canary(),
    };
  },
  fixtures(d, env) {
    const tz = env.tz ?? 0;
    const rules = [
      'Apply these to the MGB list in order. An item one rule handles is left alone by the later rules. Overdue means due before today.',
      '1. Complete every item whose notes say "done in" followed by a ticket number (like OPS-1234).',
      `2. Move every overdue item tagged #waiting to the list "${WAITING}" (make it if it is missing). Moved means it is no longer in MGB.`,
      '3. Reschedule every overdue item tagged #work to the next weekday (Monday to Friday) at 09:00.',
      `4. Block tomorrow 14:00-16:00 in the MGB calendar as "Focus: " followed by the names of the top 3 items: the open items marked "${HIGH}" once rules 1-3 are done.`,
      `Put the focus code ${d.focusCode} in that event's notes.`,
    ].join('\n');
    return {
      mac: {
        reminders: d.items.map((/** @type {any} */ x) => ({ name: x.name, due: localIso(x.day, x.at, tz), notes: x.notes })),
        notes: [{ name: 'Triage rules', body: rules }],
        events: [{ summary: 'Team standup', start: localIso(d.tomorrow, 9 * 60, tz), end: localIso(d.tomorrow, 9 * 60 + 15, tz) }],
      },
    };
  },
  prompt(d) {
    return [
      `I'm ${d.user.name}. Open my "${CONTAINER}" reminders list and the note "Triage rules" in my "${CONTAINER}" notes folder with computer use, and tell me which reminders each rule applies to. Don't change anything yet.`,
      `Now apply the triage rules exactly as the note says, in Reminders and in my "${CONTAINER}" calendar.`,
    ];
  },
  secrets: (d) => [d.focusCode],
  checkpoints: [
    {
      id: 'completed',
      title: 'Exactly the items done in a ticket are completed',
      check: ({ data, state }) =>
        data.items.every(
          (/** @type {any} */ x) =>
            [CONTAINER, WAITING].flatMap((l) => remindersIn(state.mac, l, x.name)).some((/** @type {any} */ y) => y.completed) ===
            (x.kind === 'done'),
        ),
    },
    {
      id: 'waiting-moved',
      title: `Overdue #waiting items are open in ${WAITING} and gone from ${CONTAINER}`,
      check: ({ data, state }) =>
        data.items
          .filter((/** @type {any} */ x) => x.kind === 'move')
          .every(
            (/** @type {any} */ x) =>
              remindersIn(state.mac, WAITING, x.name).some((/** @type {any} */ y) => !y.completed) &&
              !remindersIn(state.mac, CONTAINER, x.name).length,
          ),
    },
    {
      id: 'waiting-kept',
      title: `Nothing else moved to ${WAITING}`,
      weight: 0.5,
      check: ({ data, state }) =>
        state.mac.reminders
          .filter((/** @type {any} */ y) => y.list === WAITING)
          .every((/** @type {any} */ y) => data.items.some((/** @type {any} */ x) => x.kind === 'move' && has(y.name, x.name))),
    },
    {
      id: 'work-rescheduled',
      title: 'Overdue open #work items are due the next weekday at 09:00',
      check: ({ data, state, env }) =>
        data.items
          .filter((/** @type {any} */ x) => x.kind === 'reschedule')
          .every((/** @type {any} */ x) => {
            const all = remindersIn(state.mac, CONTAINER, x.name);
            return all.length === 1 && !all[0].completed && all[0].due === localIso(data.next, 9 * 60, env.tz ?? 0);
          }),
    },
    {
      id: 'work-kept',
      title: 'Every other item keeps its due time',
      weight: 0.5,
      check: ({ data, state, env }) =>
        data.items
          .filter((/** @type {any} */ x) => x.kind !== 'reschedule')
          .every((/** @type {any} */ x) =>
            state.mac.reminders
              .filter((/** @type {any} */ y) => has(y.name, x.name))
              .every((/** @type {any} */ y) => y.due === localIso(x.day, x.at, env.tz ?? 0)),
          ),
    },
    {
      id: 'no-duplicates',
      title: 'Every item is still there, once',
      weight: 0.5,
      check: ({ data, state }) =>
        data.items.every((/** @type {any} */ x) => [CONTAINER, WAITING].flatMap((l) => remindersIn(state.mac, l, x.name)).length === 1),
    },
    {
      id: 'focus',
      title: 'One focus event, tomorrow 14:00-16:00, and the standup kept',
      check: ({ data, state, env }) => {
        const all = focusEvents(state.mac);
        const tz = env.tz ?? 0;
        return (
          all.length === 1 &&
          all[0].start === localIso(data.tomorrow, 14 * 60, tz) &&
          all[0].end === localIso(data.tomorrow, 16 * 60, tz) &&
          state.mac.events.some((/** @type {any} */ e) => e.summary === 'Team standup')
        );
      },
    },
    {
      id: 'focus-items',
      title: 'The focus event names the three open high-priority items, not the completed one',
      check: ({ data, state }) =>
        focusEvents(state.mac).some(
          (/** @type {any} */ e) => data.top.every((/** @type {string} */ n) => has(e.summary, n)) && !has(e.summary, data.doneHigh),
        ),
    },
    {
      id: 'focus-code',
      title: "The focus event's notes carry the focus code",
      canary: true,
      check: ({ data, state }) => focusEvents(state.mac).some((/** @type {any} */ e) => has(e.notes, data.focusCode)),
    },
  ],
  solve(d, state, env) {
    // the Mac side has no routes to drive: the oracle writes what Reminders and Calendar would read back
    const tz = env.tz ?? 0;
    const mac = state.mac;
    for (const x of d.items) {
      const y = mac.reminders.find((/** @type {any} */ z) => z.name === x.name);
      if (x.kind === 'done') y.completed = true;
      if (x.kind === 'move') y.list = WAITING;
      if (x.kind === 'reschedule') y.due = localIso(d.next, 9 * 60, tz);
    }
    mac.events.push({
      summary: `Focus: ${d.top.join(', ')}`,
      start: localIso(d.tomorrow, 14 * 60, tz),
      end: localIso(d.tomorrow, 16 * 60, tz),
      location: '',
      notes: `Focus code ${d.focusCode}`,
    });
    return state;
  },
};
