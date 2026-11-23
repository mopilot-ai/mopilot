// Reads the interface text out of the sources and compares it with the language catalogs: what `npm run i18n:check` reports.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { LANGUAGES } from '../../shared/i18n/languages.mjs';
import { wrapInterfaceText } from './transform.mjs';

/** Main's sources that call its lookup; everything under src is read whole. */
export const MAIN_SOURCES = ['electron/app/menu.cjs'];
const SOURCE = /\.tsx?$/;
const NOT_APP_CODE = /\.test\.|\.d\.ts$/;

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });

/**
 * Every message the app can look up, in order.
 * @param {string} root the repository
 */
export function sourceMessages(root) {
  const files = [
    ...walk(path.join(root, 'src'))
      .filter((file) => SOURCE.test(file) && !NOT_APP_CODE.test(file))
      .map((file) => path.relative(root, file).replaceAll('\\', '/')),
    ...MAIN_SOURCES,
  ];
  const messages = new Set();
  for (const file of files)
    for (const message of wrapInterfaceText(readFileSync(path.join(root, file), 'utf8'), file).messages) messages.add(message);
  return [...messages].sort();
}

/**
 * What code reads in a message, so a translation can be held to it: holes by number or by name (src/harness/copy.ts fills
 * those), and the marks that code splits a line on (src/harness/switchPlan.ts).
 */
const holesOf = (message) => [...message.matchAll(/\{\w+\}|[☐·]/g)].map(([hole]) => hole).sort();

/**
 * What is wrong with a catalog as a file: text that would show a raw `{0}`, or lose a value.
 * @param {Record<string, unknown>} catalog
 * @returns {string[]}
 */
export function catalogProblems(catalog) {
  return Object.entries(catalog).flatMap(([english, text]) => {
    if (typeof text !== 'string' || !text.trim()) return [`no text for ${JSON.stringify(english)}`];
    return holesOf(english).join() === holesOf(text).join() ? [] : [`other holes than ${JSON.stringify(english)}: ${JSON.stringify(text)}`];
  });
}

/**
 * How complete each language is against the sources.
 * @param {string} root
 * @returns {{ tag: string, translated: number, missing: string[], stale: string[], problems: string[] }[]}
 */
export function catalogReport(root) {
  const messages = sourceMessages(root);
  return LANGUAGES.filter(({ tag }) => tag !== 'en').map(({ tag }) => {
    const file = path.join(root, 'shared/i18n/locales', `${tag}.json`);
    const catalog = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    const missing = messages.filter((message) => !Object.hasOwn(catalog, message));
    const stale = Object.keys(catalog).filter((english) => !messages.includes(english));
    return { tag, translated: messages.length - missing.length, missing, stale, problems: catalogProblems(catalog) };
  });
}

/**
 * The check's lines and whether it passed: only a catalog that would break the interface fails it.
 * @param {ReturnType<typeof catalogReport>} report
 * @param {number} total how many messages the sources hold
 */
export function reportLines(report, total) {
  const coverage = report.map(
    ({ tag, translated, stale, problems }) =>
      `${tag.padEnd(8)} ${translated}/${total} messages, ${stale.length} stale, ${problems.length} problems`,
  );
  const problems = report.flatMap(({ tag, problems: found }) => found.map((problem) => `${tag}: ${problem}`));
  return { lines: [...coverage, ...problems], ok: problems.length === 0 };
}
