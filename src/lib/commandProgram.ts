// The few leading words of a shell command that Claude Code's activity line names ("Running python3"), or of the first
// program inside a loop or test, withheld when the command could carry a credential.

/** Leading `cd dir &&` hops: the program is what runs after them. */
const CD_PREFIX = /^(?:cd +(?:'[^']*'|"[^"$`\\]*"|[\w./~:+,%-]+) *(?:&&|;) *)+(?=\S)/;
/** A plain word: no flag, quote, variable or redirection. */
const WORD = /^(?!-)[A-Za-z0-9._/~:+,@%-]+$/;
const HOST = '(?:[\\w-]+(?:\\.[\\w-]+)*\\.[a-z]{2,}|\\d{1,3}(?:\\.\\d{1,3}){3}|localhost)\\.?';
/** A host, address or port: where a command connects, not what it is. */
const ADDRESS = new RegExp(
  [`^${HOST}(?::[^/]*)?/`, `^${HOST}:\\d+$`, '^[\\w-]+(?:\\.[\\w-]+)+\\.:', '^[\\w-]+(?:\\.[\\w-]+)*\\.?:\\d+\\/', '^//'].join('|'),
  'i',
);
const SECRET_PART = /^(?:tokens?|passwords?|passwd|secrets?|apikeys?|credentials?)$/i;
/** Anything that can put a credential on the command line: the whole command is then left unnamed. */
const CREDENTIAL = [
  /:\/\/[^\s/?#@]+@/,
  /(?<![\w-])(?:-[a-z]*u|--(?:proxy-)?user)(?:=| *)["']?(?!\d+:\d+(?:[\s"']|$))(?=[\w.])[^\s"':]{1,256}:(?!\/\/)/i,
  /\b(?:authorization|bearer|sshpass)\b/i,
  /\b(?:mysql|mariadb)\w*\b.{0,512}\s-p\S/,
  // an environment assignment of a secret-named variable (`GITHUB_TOKEN=…`), not a flag (`--max-tokens=5`)
  /(?:^|[\s;&|])[A-Za-z_]\w*(?:token|password|passwd|secret|api_?key|credential)s?=\S/i,
];
/** Shell syntax that opens a loop, test or group: what runs is inside it. */
const OPENER = /^(?:for|select|while|until|if|case|function|\{|\(|[\w.-]+\(\)\{?)$/;
/** A shell function's definition (`function f {`, `f() {`): its body runs only when the function is called. */
const DEFINITION = /^(?:function\s+\S+|[\w.-]+\s*\(\))/;
/** Where one command inside a compound one ends and the next begins. */
const SEPARATOR = /\s*(?:;;?|&&|\|\|?|&|\n)\s*/;
/** Control words before a command inside a compound one (`do curl …`, `if ! grep …`). */
const LEAD = /^(?:(?:do|then|else|elif|if|while|until|time|!|\{|\()(?:\s+|$))+/;
/** A part that runs nothing worth naming: a loop's or case's header, a closer, a bare condition or a `cd` hop. */
const NO_PROGRAM = /^(?:for|select|case|function|done|fi|esac|\}|\)|true|false|:|\[\[?|test|cd)(?:\s|$)/;
const MAX_WORDS = 4;
/** How much of a long command is read, as Claude Code reads it. */
const READ_CHARS = 8192;

/** A word that names something private: a long mixed token, a secret-named file, or a mail-like address. */
const privateWord = (w: string) =>
  ADDRESS.test(w) ||
  w.includes('://') ||
  /%[0-9A-F]{2}/i.test(w) ||
  (w.match(/[A-Za-z0-9]{20,}/g) ?? []).some((s) => /[A-Za-z]/.test(s) && /\d/.test(s)) ||
  w
    .slice(w.lastIndexOf('/') + 1)
    .split(/[-._]/)
    .some((p, i, parts) => SECRET_PART.test(p) || (/^api$/i.test(p) && /^keys?$/i.test(parts[i + 1] ?? ''))) ||
  (w.includes('@') && (w.includes(':') || mailLike(w.replace(/(?:^|\/)@[\w-]+\//g, '/'))));

/** An `@` left after a package scope is a version (`pkg@1.2`, `pkg@next`) or else an address. */
const mailLike = (w: string) => w.includes('@') && !/^[^@]+@(?:\d[\w.+~-]*|[A-Za-z][\w-]*)$/.test(w);

/**
 * The program a command runs and up to three plain words after it ("npm run build"), `cut` when the command goes on
 * past them; null when there is nothing safe to name (a substitution, a credential, a flag first).
 */
export function commandProgram(command: string): { text: string; cut: boolean } | null {
  const read = command.slice(0, READ_CHARS);
  const start = read.search(/\S/);
  if (start < 0 || /\$\(|`|[<>]\(/.test(read) || CREDENTIAL.some((re) => re.test(read))) return null;
  const end = read.indexOf('\n', start);
  let line = read
    .slice(start, end < 0 ? undefined : end)
    .replace(/\t/g, ' ')
    .trimEnd();
  const more = command.length > READ_CHARS || (end >= 0 && /\S/.test(read.slice(end)));
  // a continued line: its trailing backslash is not a word
  if (more && line.endsWith(' \\')) line = line.slice(0, -1).trimEnd();
  const words = line.replace(CD_PREFIX, '').split(/ +/);
  // a line cut by the read limit ends in part of a word
  if (end < 0 && command.length > READ_CHARS) words.pop();
  if (OPENER.test(words[0])) return compoundProgram(command, read.slice(start).replace(CD_PREFIX, ''));
  const named = plainWords(words);
  if (!named.length) return null;
  return { text: named.join(' '), cut: more || named.length < words.length };
}

/** The program and plain words that lead a command's words, up to the first that is not safe to name. */
function plainWords(words: string[]): string[] {
  const named: string[] = [];
  for (const w of words) {
    if (named.length === MAX_WORDS || !WORD.test(w) || privateWord(w)) break;
    named.push(w);
  }
  return named;
}

/**
 * A loop, test or group (`for i in 1 2; do curl …; done`) is named by the first program it runs, past its header and
 * a bare condition; null when that program is not safe to name, never the shell syntax itself.
 */
function compoundProgram(command: string, body: string): { text: string; cut: boolean } | null {
  // a body cut by the read limit ends in part of a word
  const read = command.length > READ_CHARS ? body.slice(0, body.search(/\S*$/)) : body;
  let defining = false;
  for (const part of read.split(SEPARATOR)) {
    // a definition's body is skipped up to its closing brace
    if (defining || DEFINITION.test(part)) {
      defining = !/(?:^|\s)\}$/.test(part);
      continue;
    }
    const run = part.replace(LEAD, '').trim();
    if (!run || NO_PROGRAM.test(run)) continue;
    const named = plainWords(run.replace(/\t/g, ' ').split(/ +/));
    return named.length ? { text: named.join(' '), cut: true } : null;
  }
  return null;
}
