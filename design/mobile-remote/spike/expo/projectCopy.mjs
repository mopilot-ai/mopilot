// What the native release check copies: mobile/ without generated output, plus every repository file the phone imports from outside it.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const GENERATED_AT_ROOT = new Set(['ios', 'android', 'dist']);
const SOURCE = /\.(?:tsx?|jsx?|mjs|cjs)$/;
const EXTENSIONS = ['', '.ts', '.tsx', '.mjs', '.cjs', '.js', '.jsx'];
const IMPORT = /(?:\bfrom\s+|\bimport\s+|\bimport\(\s*|\brequire\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

/** @param {string} root the folder being copied @param {string} source a path inside it @returns {boolean} whether to copy it */
export function copiesIntoScratch(root, source) {
  const parts = path.relative(root, source).split(path.sep);
  if (parts.includes('node_modules')) return false;
  return !GENERATED_AT_ROOT.has(parts[0]);
}

/** @param {string} specifier a relative import @param {string} from the importing file @returns {string | null} the file it names */
function resolved(specifier, from) {
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [...EXTENSIONS.map((ext) => base + ext), ...EXTENSIONS.slice(1).map((ext) => path.join(base, `index${ext}`))]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** @param {string} folder @param {string} mobile @returns {string[]} the source files mobile/ ships */
function mobileSources(folder, mobile) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(folder, entry.name);
    if (!copiesIntoScratch(mobile, full)) return [];
    if (entry.isDirectory()) return mobileSources(full, mobile);
    return SOURCE.test(entry.name) ? [full] : [];
  });
}

/**
 * The files outside mobile/ that its sources reach through relative imports, followed transitively, as paths from the repository root.
 * An import that names no file is left for the bundler to report.
 * @param {string} repo the repository root
 * @returns {string[]}
 */
export function phoneImportsOutsideMobile(repo) {
  const mobile = path.join(repo, 'mobile');
  const inside = (/** @type {string} */ file) => !path.relative(mobile, file).startsWith('..');
  const queue = mobileSources(mobile, mobile);
  const seen = new Set(queue);
  /** @type {Set<string>} */
  const outside = new Set();
  while (queue.length) {
    const file = /** @type {string} */ (queue.pop());
    for (const [, specifier] of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const target = resolved(specifier, file);
      if (!target || seen.has(target) || inside(target)) continue;
      seen.add(target);
      outside.add(path.relative(repo, target));
      if (SOURCE.test(target)) queue.push(target);
    }
  }
  return [...outside].sort();
}
