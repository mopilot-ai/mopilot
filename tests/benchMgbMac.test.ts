// bench/lib/mgb/mac.mjs (#1381): the `mac` source: seeded Calendar, Reminders and Notes state, and the JXA
// scripts that seed and read them, run here against a fake scripting bridge that behaves like the apps' dictionaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const mac = await import('../bench/lib/mgb/mac.mjs');
const { CONTAINER, initMac, listName, macReadScript, macSetupScript, overlaps, parseMac } = mac;

/** A fake of the JXA bridge: element arrays with whose(), push(), delete(), and property getters as functions. */
function fakeMac(seed: { calendars?: any[]; lists?: any[]; folders?: any[] } = {}) {
  const coll = (items: any[]) => {
    const f: any = () => items;
    f.whose = (q: any) => () => items.filter((x) => x.name() === q.name);
    f.push = (x: any) => items.push(x);
    return f;
  };
  const obj = (props: Record<string, any>, kids: Record<string, any[]> = {}) => {
    const o: any = { _: props };
    for (const [k, v] of Object.entries(props)) o[k] = () => v;
    for (const [k, v] of Object.entries(kids)) o[k] = coll(v);
    return o;
  };
  const withDelete = (parent: any[], o: any) => {
    o.delete = () => parent.splice(parent.indexOf(o), 1);
    return o;
  };
  const calendars: any[] = seed.calendars ?? [];
  const lists: any[] = seed.lists ?? [];
  const folders: any[] = seed.folders ?? [];
  const apps: Record<string, any> = {
    Calendar: {
      calendars: coll(calendars),
      Calendar: (p: any) => obj(p, { events: [] }),
      Event: (p: any) => p,
    },
    Reminders: { lists: coll(lists), List: (p: any) => obj(p, { reminders: [] }), Reminder: (p: any) => p },
    Notes: { folders: coll(folders), Folder: (p: any) => obj(p, { notes: [] }), Note: (p: any) => p },
  };
  const run = (script: string) =>
    vm.runInNewContext(script, {
      Application: (name: string) => apps[name],
      Path: (p: string) => p,
      JSON,
      Date,
    });
  // wrap pushes so pushed plain objects become live items
  const live = (arr: any[], toObj: (p: any) => any) => {
    // like JXA, an element list is a snapshot: deleting while looping over it skips nothing
    const f: any = () => [...arr];
    f.whose = (q: any) => () => arr.filter((x) => x.name() === q.name);
    f.push = (p: any) => arr.push(withDelete(arr, toObj(p)));
    return f;
  };
  apps.Calendar.calendars = live(calendars, (c) => {
    const events: any[] = [];
    const o = obj({ name: c._.name });
    o.events = live(events, (e) =>
      obj({ summary: e.summary, startDate: e.startDate, endDate: e.endDate, location: e.location, description: e.description, url: e.url }),
    );
    return o;
  });
  apps.Reminders.lists = live(lists, (l) => {
    const rs: any[] = [];
    const o = obj({ name: l._.name });
    o.reminders = live(rs, (r) => obj({ name: r.name, dueDate: r.dueDate ?? null, completed: r.completed, body: r.body }));
    return o;
  });
  apps.Notes.folders = live(folders, (f) => {
    const ns: any[] = [];
    const o = obj({ name: f._.name });
    o.notes = live(ns, (n) =>
      obj({
        name: n.name,
        plaintext: n.body
          .replace(/<[^>]+>/g, '\n')
          .replace(/\n+/g, '\n')
          .trim()
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&'),
      }),
    );
    return o;
  });
  return { run, calendars, lists, folders, apps };
}

const fixture = {
  events: [
    { summary: 'Standup', start: '2026-10-20T09:00:00Z', end: '2026-10-20T09:15:00Z', location: 'Room 2' },
    { summary: 'Sync', start: '2026-10-20T10:00:00Z', end: '2026-10-20T10:30:00Z', url: 'https://meet.example.test/abc' },
  ],
  reminders: [
    { name: 'Book train', due: '2026-10-21T08:00:00Z' },
    { list: 'Prep', name: 'Print slides', completed: true, notes: 'color' },
  ],
  notes: [{ name: 'Week plan', body: 'Mon: travel\nTue: <workshop>' }],
};

test('initMac normalizes a fixture and refuses broken ones', () => {
  const m = initMac(fixture);
  assert.deepEqual(m.events[0], {
    summary: 'Standup',
    start: '2026-10-20T09:00:00.000Z',
    end: '2026-10-20T09:15:00.000Z',
    location: 'Room 2',
    notes: '',
    url: '',
  });
  assert.equal(m.events[1].url, 'https://meet.example.test/abc');
  assert.deepEqual(
    m.reminders.map((r: any) => [r.list, r.due, r.completed, r.notes]),
    [
      ['MGB', '2026-10-21T08:00:00.000Z', false, ''],
      ['MGB Prep', null, true, 'color'],
    ],
  );
  assert.deepEqual(initMac(undefined), { events: [], reminders: [], notes: [] });
  assert.deepEqual(initMac({ notes: [{ name: 'Empty' }] }).notes, [{ name: 'Empty', body: '' }]);
  for (const [f, want] of [
    [{ events: [{}] }, /needs a summary/],
    [{ events: [{ summary: 'x', start: 'soon', end: '2026-10-20T09:00:00Z' }] }, /start is not a date/],
    [{ events: [{ summary: 'x', start: '2026-10-20T10:00:00Z', end: '2026-10-20T09:00:00Z' }] }, /ends before it starts/],
    [{ reminders: [{}] }, /reminder needs a name/],
    [{ reminders: [{ name: 'r', due: 'x' }] }, /due is not a date/],
    [{ notes: [{}] }, /note needs a name/],
  ] as [any, RegExp][])
    assert.throws(() => initMac(f), want);
  assert.equal(CONTAINER, 'MGB');
  assert.equal(listName('Prep'), 'MGB Prep');
});

test('the setup script empties only the bench containers and seeds them; the read script gives them back', () => {
  const m = initMac(fixture);
  const other = {
    name: () => 'Home',
    reminders: Object.assign(() => [{ name: () => 'keep me', delete: () => assert.fail('a list outside the bench was touched') }], {}),
  };
  const fake = fakeMac();
  fake.lists.push(other);
  assert.equal(fake.run(macSetupScript(m)), 'ok');
  assert.equal(fake.run(macSetupScript(m)), 'ok', 'a second run replaces, never duplicates');
  const read = parseMac(fake.run(macReadScript()));
  assert.deepEqual(read.events, m.events);
  assert.deepEqual(read.reminders, m.reminders);
  assert.deepEqual(read.notes, [{ name: 'Week plan', body: 'Week plan\nMon: travel\nTue: <workshop>' }]);
  assert.equal('numbers' in read, false, 'spreadsheets are files in the task folder, not a Mac app');
  assert.deepEqual(
    fake.lists.map((l: any) => l.name()),
    ['Home', 'MGB', 'MGB Prep'],
  );
});

test("Notes is seeded and read on this Mac's own account when an internet account is Notes' default (#3715)", () => {
  const m = initMac(fixture);
  // the app's top-level folders are the default (Google) account's; "On My Mac" has its own
  const fake = fakeMac();
  const local = fakeMac();
  fake.apps.Notes.accounts = Object.assign(() => [], {
    whose: (q: any) => () => (q.name === 'On My Mac' ? [{ folders: local.apps.Notes.folders }] : []),
  });
  assert.equal(fake.run(macSetupScript(m)), 'ok');
  assert.equal(fake.run(macSetupScript(m)), 'ok', 'a second run finds the folder on this Mac, never a duplicate');
  assert.deepEqual(
    local.folders.map((f: any) => f.name()),
    ['MGB'],
  );
  assert.deepEqual(fake.folders, [], 'nothing is created in the internet account');
  assert.deepEqual(parseMac(fake.run(macReadScript())).notes, [{ name: 'Week plan', body: 'Week plan\nMon: travel\nTue: <workshop>' }]);
});

test('parseMac refuses a broken read, and normalizes what it keeps', () => {
  assert.throws(() => parseMac('{}'), /no events, reminders or notes/);
  assert.throws(() => parseMac('null'), /no events/);
  assert.throws(() => parseMac('not json'));
  const m = parseMac(JSON.stringify({ events: [{}], reminders: [{ list: 'MGB' }], notes: [{}] }));
  assert.deepEqual(m, {
    events: [{ summary: '', start: null, end: null, location: '', notes: '', url: '' }],
    reminders: [{ list: 'MGB', name: '', due: null, completed: false, notes: '' }],
    notes: [{ name: '', body: '' }],
  });
});

test('overlaps and gaps between events', () => {
  const a = { start: '2026-10-20T09:00:00.000Z', end: '2026-10-20T10:00:00.000Z' };
  const b = { start: '2026-10-20T10:00:00.000Z', end: '2026-10-20T11:00:00.000Z' };
  const c = { start: '2026-10-20T09:30:00.000Z', end: '2026-10-20T09:45:00.000Z' };
  assert.equal(overlaps(a, b), false, 'touching ends do not overlap');
  assert.equal(overlaps(a, c), true);
});
