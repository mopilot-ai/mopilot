// MoPilot 12-Grid Bench (#1381) `mac` source: the built-in macOS apps a CU task works in (Calendar, Reminders, Notes),
// isolated in containers named for the bench, as JXA scripts that seed and read them and the state graders see.

/** The calendar, reminder lists' prefix and notes folder the bench owns: tasks never touch anything else on the Mac. */
export const CONTAINER = 'MGB';

/**
 * A task's `mac` fixture as the state the runner would read back before the agent did anything.
 * Fixture: `{ events?: [{ summary, start, end, location?, notes?, url? }], reminders?: [{ list?, name, due?, notes?,
 * completed? }], notes?: [{ name, body }] }`. Times are ISO. (Spreadsheets are CSV files in the task folder, the `files`
 * source: Numbers comes from the App Store, which a benchmark VM cannot sign in to.)
 * @param {any} f
 */
export function initMac(f) {
  const iso = (/** @type {unknown} */ v, /** @type {string} */ what) => {
    const t = Date.parse(String(v));
    if (!Number.isFinite(t)) throw new Error(`${what} is not a date: ${v}`);
    return new Date(t).toISOString();
  };
  const events = (f?.events ?? []).map((/** @type {any} */ e) => {
    if (!e?.summary) throw new Error('a calendar event needs a summary');
    const start = iso(e.start, `event ${e.summary} start`);
    const end = iso(e.end, `event ${e.summary} end`);
    if (end <= start) throw new Error(`event ${e.summary} ends before it starts`);
    return {
      summary: String(e.summary),
      start,
      end,
      location: String(e.location ?? ''),
      notes: String(e.notes ?? ''),
      url: String(e.url ?? ''),
    };
  });
  const reminders = (f?.reminders ?? []).map((/** @type {any} */ r) => {
    if (!r?.name) throw new Error('a reminder needs a name');
    return {
      list: listName(r.list),
      name: String(r.name),
      due: r.due ? iso(r.due, `reminder ${r.name} due`) : null,
      completed: !!r.completed,
      notes: String(r.notes ?? ''),
    };
  });
  const notes = (f?.notes ?? []).map((/** @type {any} */ n) => {
    if (!n?.name) throw new Error('a note needs a name');
    return { name: String(n.name), body: String(n.body ?? '') };
  });
  return { events, reminders, notes };
}

/** A reminder list the bench owns: "MGB" or "MGB <name>". @param {unknown} name */
export const listName = (name) => (name ? `${CONTAINER} ${name}` : CONTAINER);

/**
 * Notes' folders on this Mac ("On My Mac"), not the default account's: once an internet account (a Google account in
 * the bench VM, #3715) becomes Notes' default, the app's top-level folders are that account's, the bench folder is not
 * found there, and creating it again fails with "Duplicate folder name". Falls back to the app's folders when the Mac
 * has no local account.
 */
const LOCAL_FOLDERS = `function localFolders(notes){const a=notes.accounts?notes.accounts.whose({name:'On My Mac'})():[]; return a.length?a[0].folders:notes.folders;}`;

/**
 * The JXA script that empties the bench's containers and seeds a task's Calendar, Reminders and Notes items. Run with
 * `osascript -l JavaScript` in the GUI session; it prints "ok".
 * @param {ReturnType<typeof initMac>} mac
 */
export function macSetupScript(mac) {
  return `const D=${JSON.stringify({ C: CONTAINER, events: mac.events, reminders: mac.reminders, notes: mac.notes })};
function own(coll, name, make){let x=coll.whose({name:name})(); if(x.length) return x[0]; const o=make({name:name}); coll.push(o); return coll.whose({name:name})()[0];}
const cal=Application('Calendar'); const c=own(cal.calendars, D.C, (p)=>cal.Calendar(p));
for (const e of c.events()) e.delete();
for (const e of D.events) c.events.push(cal.Event(Object.assign({summary:e.summary,startDate:new Date(e.start),endDate:new Date(e.end),location:e.location,description:e.notes}, e.url?{url:e.url}:{})));
const rem=Application('Reminders');
for (const l of rem.lists()) if (l.name()===D.C || l.name().startsWith(D.C+' ')) { for (const r of l.reminders()) r.delete(); }
for (const r of D.reminders){const l=own(rem.lists, r.list, (p)=>rem.List(p)); const p={name:r.name,body:r.notes,completed:r.completed}; if(r.due) p.dueDate=new Date(r.due); l.reminders.push(rem.Reminder(p));}
const notes=Application('Notes'); const f=own(localFolders(notes), D.C, (p)=>notes.Folder(p));
for (const n of f.notes()) n.delete();
for (const n of D.notes) f.notes.push(notes.Note({name:n.name,body:'<div><h1>'+esc(n.name)+'</h1></div>'+n.body.split('\\n').map((l)=>'<div>'+esc(l)+'</div>').join('')}));
function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
${LOCAL_FOLDERS}
'ok'`;
}

/**
 * The JXA script that reads the bench's containers back as JSON: every event in the bench's calendar (with its URL
 * field), every reminder
 * in its lists and every note in its folder (plain text).
 */
export function macReadScript() {
  return `const D=${JSON.stringify({ C: CONTAINER })};
const out={events:[],reminders:[],notes:[]};
const cal=Application('Calendar'); for (const c of cal.calendars.whose({name:D.C})()) for (const e of c.events()) out.events.push({summary:e.summary(),start:e.startDate().toISOString(),end:e.endDate().toISOString(),location:e.location()||'',notes:e.description()||'',url:(typeof e.url==='function'&&e.url())||''});
const rem=Application('Reminders'); for (const l of rem.lists()) { const ln=l.name(); if (ln!==D.C && !ln.startsWith(D.C+' ')) continue; for (const r of l.reminders()) { const due=r.dueDate(); out.reminders.push({list:ln,name:r.name(),due:due?due.toISOString():null,completed:r.completed(),notes:r.body()||''}); } }
${LOCAL_FOLDERS}
const notes=Application('Notes'); for (const f of localFolders(notes).whose({name:D.C})()) for (const n of f.notes()) out.notes.push({name:n.name(),body:n.plaintext()});
JSON.stringify(out)`;
}

/**
 * The read-back JSON as the `mac` source, with times normalized; a missing or broken read is an error, never an empty
 * Mac (an empty Mac would grade as "the agent did nothing").
 * @param {string} text
 */
export function parseMac(text) {
  const raw = JSON.parse(text);
  if (!raw || !Array.isArray(raw.events) || !Array.isArray(raw.reminders) || !Array.isArray(raw.notes))
    throw new Error('the Mac read gave no events, reminders or notes');
  const iso = (/** @type {unknown} */ v) => (v ? new Date(String(v)).toISOString() : null);
  return {
    events: raw.events.map((/** @type {any} */ e) => ({
      summary: String(e.summary ?? ''),
      start: iso(e.start),
      end: iso(e.end),
      location: String(e.location ?? ''),
      notes: String(e.notes ?? ''),
      // the event's URL field: where Calendar keeps a meeting link
      url: String(e.url ?? ''),
    })),
    reminders: raw.reminders.map((/** @type {any} */ r) => ({
      list: String(r.list),
      name: String(r.name ?? ''),
      due: iso(r.due),
      completed: !!r.completed,
      notes: String(r.notes ?? ''),
    })),
    notes: raw.notes.map((/** @type {any} */ n) => ({ name: String(n.name ?? ''), body: String(n.body ?? '') })),
  };
}

/** Whether two time ranges overlap (touching ends do not). @param {{ start: string, end: string }} a @param {{ start: string, end: string }} b */
export const overlaps = (a, b) => a.start < b.end && b.start < a.end;
