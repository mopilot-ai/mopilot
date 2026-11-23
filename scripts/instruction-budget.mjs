// Checks the byte budgets and local references of always-loaded rules and marked development workflow skills.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { fromMarkdown } from 'mdast-util-from-markdown';

export const LIMITS = { instructions: 6 * 1024, workflows: 12 * 1024 };
const ROOT = fileURLToPath(new URL('..', import.meta.url));

function isWorkflow(text, file) {
  if (!/^---\r?\n/.test(text)) return false;
  const matter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!matter) throw new Error(`${file}: unclosed front matter`);
  try {
    return load(matter[1])?.metadata?.instruction_budget === 'workflow';
  } catch (error) {
    throw new Error(`${file}: invalid front matter: ${error.message}`);
  }
}

function* localReferences(node) {
  if (node.url && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(node.url)) yield decodeURIComponent(node.url.split('#')[0].split('?')[0]);
  for (const child of node.children ?? []) yield* localReferences(child);
}

/** Workflow skills declare their participation; adding a skill needs no shared path registry. */
export function instructionEntries(root) {
  const read = (file, kind) => ({ file, kind, text: readFileSync(path.join(root, file), 'utf8') });
  const entries = [read('AGENTS.md', 'instructions')];
  const folder = '.agents/skills';
  for (const dir of readdirSync(path.join(root, folder), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const file = `${folder}/${dir.name}/SKILL.md`;
    if (!existsSync(path.join(root, file))) continue;
    const entry = read(file, 'workflows');
    if (isWorkflow(entry.text, file)) entries.push(entry);
  }
  return entries;
}

/** Read-only admission check; byte counts include all injected entrypoint text, not conditional references. */
export function auditInstructions(root) {
  const entries = instructionEntries(root);
  const totals = { instructions: 0, workflows: 0 };
  const issues = [];
  for (const entry of entries) {
    totals[entry.kind] += Buffer.byteLength(entry.text, 'utf8');
    for (const target of localReferences(fromMarkdown(entry.text))) {
      if (!existsSync(path.resolve(root, path.dirname(entry.file), target)))
        issues.push(`${entry.file}: missing local reference ${target}`);
    }
  }
  for (const kind of Object.keys(LIMITS))
    if (totals[kind] > LIMITS[kind]) issues.push(`${kind}: ${totals[kind]} bytes exceeds ${LIMITS[kind]}`);
  return {
    entries: entries.map(({ file, kind, text }) => ({ file, kind, bytes: Buffer.byteLength(text, 'utf8') })),
    totals,
    issues,
  };
}

export function main(args, { root = ROOT, log = console.log } = {}) {
  if (args.some((arg) => arg !== '--json')) throw new Error('Usage: node scripts/instruction-budget.mjs [--json]');
  const result = auditInstructions(root);
  log(
    args.includes('--json')
      ? JSON.stringify(result)
      : `Instructions: ${result.totals.instructions}/${LIMITS.instructions} bytes; workflows: ${result.totals.workflows}/${LIMITS.workflows} bytes` +
          (result.issues.length ? `\n${result.issues.join('\n')}` : '; local references intact'),
  );
  return result.issues.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
