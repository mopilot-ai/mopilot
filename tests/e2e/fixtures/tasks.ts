// Finds the folder of a scheduled task the app created, by the name the spec gave it. The id rule is the app's own
// (taskIdPrefix in electron/platform/automationStore.cjs), imported rather than restated: a spec that named the folder
// broke when the id gained a unique suffix (#851), and the import lets npm run test:related name these specs for a
// change to that rule.
import fs from 'node:fs';
import path from 'node:path';
// a default import of the CommonJS module works both in Playwright (which compiles specs to CommonJS, where
// import.meta does not exist) and in the unit test that loads this file as ESM
import automationStore from '../../../electron/platform/automationStore.cjs';

const { taskIdPrefix } = automationStore;

/** The automation.toml of the one task in `automationsDir` named `name`, or '' when there is none yet. */
export function createdTaskFile(automationsDir: string, name: string): string {
  const prefix: string = taskIdPrefix(name);
  const ids = fs.existsSync(automationsDir)
    ? fs.readdirSync(automationsDir).filter((id) => id === prefix || id.startsWith(`${prefix}-`))
    : [];
  if (ids.length > 1) throw new Error(`more than one task named ${name}: ${ids.join(', ')}`);
  return ids.length ? path.join(automationsDir, ids[0], 'automation.toml') : '';
}

/** That task's file as text, or '' while it does not exist yet (for expect.poll). */
export function createdTaskText(automationsDir: string, name: string): string {
  const file = createdTaskFile(automationsDir, name);
  return file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}
