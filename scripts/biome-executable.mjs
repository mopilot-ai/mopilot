// Static Biome executable paths in real JS/TS syntax, not source programs stored in comments or fixture strings.
import { parseAst } from 'rolldown/parseAst';

// A whole path value, not a program containing one. Include Windows launchers and both installed entry points.
const EXECUTABLE = /^(?:[^\r\n"'`();{}]*[/\\])?(?:\.bin[/\\]biome|@biomejs[/\\]biome[/\\]bin[/\\]biome)(?:\.(?:cmd|exe))?$/;

/** Statically spelled path pieces; unknown roots do not hide a known executable suffix. @param {any} node */
function pathText(node) {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral') return node.quasis.map((part) => part.value.cooked ?? part.value.raw).join('root');
  if (node.type === 'CallExpression') {
    const callee = node.callee;
    const name = callee.type === 'MemberExpression' ? (callee.property.name ?? callee.property.value) : callee.name;
    if (['join', 'resolve'].includes(name)) return node.arguments.map(pathText).join('/');
  }
  return '';
}

/**
 * Whether source syntax owns an installed Biome executable path, including constants and joined/template paths.
 * This is a conservative static-path guard, not dynamic dataflow analysis. Parse failures stay failures.
 */
export function hasBiomeExecutable(/** @type {string} */ text, /** @type {string} */ file = 'source.ts') {
  // Most graph files cannot name this executable. Keep escaped letters/code points and line continuations eligible.
  if (!/b\\?i\\?o\\?m\\?e|\\[ux0-7\r\n\u2028\u2029]/.test(text)) return false;
  /** @param {any} node */
  const visit = (node) => {
    if (!node || typeof node !== 'object') return false;
    if (EXECUTABLE.test(pathText(node))) return true;
    return Object.values(node).some(visit);
  };
  const lang = /\.d\.[cm]?ts$/.test(file) ? 'dts' : file.endsWith('x') ? 'tsx' : 'ts';
  return visit(parseAst(text, { lang }, file));
}
