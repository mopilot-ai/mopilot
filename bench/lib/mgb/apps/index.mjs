// MoPilot 12-Grid Bench (#1381) fixture-app registry: every app bench/mgb-serve.mjs serves, and loading a task's
// fixtures into the state the server would report, as the audit and the oracles see it.
import { initChats } from '../chats.mjs';
import { initFiles } from '../files.mjs';
import { initMac } from '../mac.mjs';
import { account } from './account.mjs';
import { crm } from './crm.mjs';
import { docs } from './docs.mjs';
import { mail } from './mail.mjs';
import { idcheck, onboard } from './onboard.mjs';
import { shop } from './shop.mjs';
import { tracker } from './tracker.mjs';
import { vendors } from './vendors.mjs';

/** @type {import('./server.mjs').App[]} */
export const APPS = [mail, crm, shop, tracker, docs, vendors, onboard, idcheck, account];
export const APP_BY_NAME = Object.fromEntries(APPS.map((a) => [a.name, a]));

/**
 * A task's fixtures as the state graders read: each app's fixture through its `init`, the task folder's seeded files
 * as the runner would read them back (`files`), the Mac's apps as the runner reads them back (`mac`), and MoPilot's
 * cross-session journal (`chats`, empty when a run starts). Throws
 * on an unknown source or a broken fixture.
 * @param {Record<string, any>} fixtures
 */
export function loadFixtures(fixtures) {
  return Object.fromEntries(
    Object.entries(fixtures).map(([name, f]) => {
      if (name === 'files') return [name, initFiles(f)];
      if (name === 'mac') return [name, initMac(f)];
      if (name === 'chats') return [name, initChats(f)];
      const app = APP_BY_NAME[name];
      if (!app) throw new Error(`no fixture app named ${name}`);
      return [name, app.init(structuredClone(f))];
    }),
  );
}
