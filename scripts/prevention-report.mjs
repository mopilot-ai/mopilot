// Summarize explicit bug-class and recurrence records from a local export of merged pull requests.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fromMarkdown } from 'mdast-util-from-markdown';

/** Class names come from the index, never a second hand-maintained taxonomy. */
export function classSlugs(index) {
  const slugs = [...index.matchAll(/^\| \[[^\]]+\]\(([a-z-]+)\.md\) \|/gm)].map((match) => match[1]);
  if (!slugs.length) throw new Error('No bug classes found in the prevention index.');
  return new Set(slugs);
}

/** Read only plain paragraphs owned by one visible level-two Prevention record heading. */
function recordText(body) {
  let sections = 0;
  let active = false;
  const paragraphs = [];
  for (const node of fromMarkdown(body).children) {
    if (node.type === 'heading') {
      active =
        node.depth === 2 &&
        node.children.every((child) => child.type === 'text') &&
        node.children
          .map((child) => child.value)
          .join('')
          .toLowerCase() === 'prevention record';
      if (active) sections++;
    } else if (active && node.type === 'paragraph' && node.children.every((child) => child.type === 'text')) {
      paragraphs.push(node.children.map((child) => child.value).join(''));
    }
  }
  return sections === 1 ? paragraphs.join('\n') : null;
}

/** Missing or contradictory metadata is unknown, not a guessed classification. */
function field(body, name) {
  const text = recordText(body);
  if (text === null) return null;
  const matches = [...text.matchAll(new RegExp(`^${name}:[ \\t]*(.*)$`, 'gmi'))];
  return matches.length === 1 ? matches[0][1].trim().toLowerCase() : null;
}

/** Only explicit PR references establish a reported recurrence; similar titles/classes do not. */
function recurrence(value, number) {
  if (value === 'none known') return [];
  if (!value || value.replace(/#[1-9]\d*/g, '').replace(/[\s,]/g, '')) return null;
  const refs = [...value.matchAll(/#([1-9]\d*)/g)].map((match) => Number(match[1]));
  if (!refs.length || refs.some((ref) => !Number.isSafeInteger(ref) || ref === number)) return null;
  return [...new Set(refs)];
}

/** Input is gh's number/body/mergedAt export; reject incomplete/open/duplicate records before counting. */
export function preventionReport(input, classes) {
  if (!Array.isArray(input)) throw new TypeError('Expected an array of merged pull requests.');
  const seen = new Set();
  const counts = new Map();
  const nonBug = [];
  const unclassified = [];
  const unknownRecurrence = [];
  const recurrences = [];
  const dates = [];
  for (const row of input) {
    if (
      !row ||
      !Number.isSafeInteger(row.number) ||
      row.number <= 0 ||
      seen.has(row.number) ||
      typeof row.body !== 'string' ||
      typeof row.mergedAt !== 'string' ||
      !Number.isFinite(Date.parse(row.mergedAt))
    )
      throw new TypeError('Each PR needs a unique positive safe-integer number, string body and valid mergedAt.');
    seen.add(row.number);
    dates.push(new Date(row.mergedAt).toISOString());
    const kind = field(row.body, 'Bug class');
    if (kind === 'none') {
      nonBug.push(row.number);
      continue;
    }
    if (!classes.has(kind)) {
      unclassified.push(row.number);
      continue;
    }
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    const refs = recurrence(field(row.body, 'Recurs after'), row.number);
    if (refs === null) unknownRecurrence.push(row.number);
    else if (refs.length) recurrences.push({ number: row.number, bugClass: kind, recursAfter: refs });
  }
  dates.sort();
  return {
    scope: { mergedPullRequests: input.length, firstMergedAt: dates[0] ?? null, lastMergedAt: dates.at(-1) ?? null },
    byClass: Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b))),
    nonBug,
    unclassified,
    unknownRecurrence,
    recurrences,
  };
}

export function main(args) {
  if (args.length !== 1) throw new Error('Usage: node scripts/prevention-report.mjs <merged-prs.json>');
  const classes = classSlugs(readFileSync(new URL('../docs/bug-prevention/README.md', import.meta.url), 'utf8'));
  return preventionReport(JSON.parse(readFileSync(args[0], 'utf8')), classes);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(main(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
