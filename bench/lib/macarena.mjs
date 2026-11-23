// MacArena task scripts: each task's reset with our extra resets for stale state, the files a task copies in first,
// and known shortest solutions that prove a grader can say true (`node bench/mac-validate.mjs`).
import path from 'node:path';

/**
 * Extra resets for graders that stale state can fool. 4f0d1950's grader finds any note named "Meeting Notes", and
 * its own reset deletes only the first (deleted notes stay findable), so older copies are renamed out of the way
 * first; nothing is deleted.
 */
export const EXTRA_PRE = {
  '4f0d1950': `osascript -e 'tell application "Notes" to repeat with n in (every note whose name is "Meeting Notes")
set name of n to "Meeting Notes (stale)"
end repeat'`,
};

/** Known solutions, done the shortest way (no GUI): they only prove each grader can say true. */
export const SOLUTIONS = {
  a13331ed: 'cp ~/Downloads/Recipe.txt ~/Desktop/Copied_Recipe.txt',
  '4f0d1950': `osascript -e 'tell application "Notes" to make new note with properties {name:"Meeting Notes", body:"<h1>Meeting Notes</h1><ul><li>Review agenda</li><li>Take notes</li><li>Set follow-up tasks</li></ul>"}'`,
  '7bcb0652': `osascript -e 'tell application "Reminders" to move (first reminder of list "Groceries" whose name is "Buy milk") to list "Errands"'`,
  e7480f08: `osascript -e 'tell application "Contacts"
set p to make new person with properties {first name:"John", last name:"Doe", organization:"Example Corp"}
make new phone at end of phones of p with properties {label:"work", value:"555-1234"}
make new email at end of emails of p with properties {label:"work", value:"john.doe@example.com"}
save
end tell'`,
  '24f5dc8b': `osascript -e 'tell application "Calendar"
set d to current date
set year of d to 2025
set month of d to October
set day of d to 29
set hours of d to 14
set minutes of d to 0
set seconds of d to 0
set e to make new event at end of events of calendar "Calendar" with properties {summary:"Project Deadline Review", start date:d, end date:d + 3600}
make new display alarm at end of display alarms of e with properties {trigger interval:-15}
end tell'`,
};

/** The reset scripts to run, in order, for a task. @param {{ id: string, pre_command?: string }} t */
export function resetScripts(t) {
  const extra = EXTRA_PRE[t.id];
  return [...(extra ? [extra] : []), ...(t.pre_command ? [t.pre_command] : [])];
}

/**
 * The files a task needs in place before it starts: from the MacArena checkout to a path in the VM user's home.
 * @param {{ pre_upload_files?: { local_path: string, path: string }[] }} t @param {string} macarenaRoot @param {string} home
 */
export function uploads(t, macarenaRoot, home) {
  return (t.pre_upload_files ?? []).map((f) => ({
    from: path.join(macarenaRoot, f.local_path),
    to: f.path.startsWith('~/') ? path.join(home, f.path.slice(2)) : f.path,
  }));
}
