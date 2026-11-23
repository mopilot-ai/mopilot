// The rules the approval gate reads: an owner's allow, ask or deny rule names a tool, an effect and a scope with `*` globs (a backslash makes the next character literal), and matching is exact and whole-value (glob matching after OpenClaudeDuet approvals/policy.ts, MIT, see NOTICE).

export type Effect = 'read' | 'notes' | 'write' | 'send' | 'delete' | 'spend' | 'settings';
export type Behavior = 'allow' | 'ask' | 'deny';

export interface GateRule {
  id: string;
  behavior: Behavior;
  /** Tool name glob, for example `gmail.*`. */
  tool: string;
  /** An effect name or `*`. */
  effect: string;
  /** What the action touches (a recipient, a calendar, a folder) as a glob. */
  scope: string;
  /** The rule in plain language, as the owner sees and edits it. */
  text: string;
}

/** Makes a literal value safe to use as a pattern: `*` and the backslash lose their meaning. */
export const escapeGlob = (value: string): string => value.replace(/[\\*]/g, '\\$&');

/** What a rule and a value are compared as: compatibility forms folded, invisible format characters removed, letter case ignored (an address is the same address in any case). */
const fold = (text: string): string =>
  text
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .toLowerCase();

type Token = { star: true } | { star: false; ch: string };

/** `*` matches any run of characters; `\` makes the next character literal; everything else is literal and the whole value must match. Matching walks the value once with one place to back up to, so no pattern a model or an owner wrote can take long (no regular expression is built). */
export function globMatches(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  const tokens: Token[] = [];
  const chars = [...pattern];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '*') tokens.push({ star: true });
    else for (const ch of fold(chars[i] === '\\' && i + 1 < chars.length ? chars[++i] : chars[i])) tokens.push({ star: false, ch });
  }
  const text = [...fold(value)];
  let p = 0;
  let v = 0;
  let starAt = -1;
  let starV = 0;
  while (v < text.length) {
    const t = tokens[p];
    if (t && !t.star && t.ch === text[v]) {
      p++;
      v++;
    } else if (t?.star) {
      starAt = p++;
      starV = v;
    } else if (starAt >= 0) {
      p = starAt + 1;
      v = ++starV;
    } else return false;
  }
  while (tokens[p]?.star) p++;
  return p === tokens.length;
}

export interface Target {
  tool: string;
  effect: Effect;
  scope: string;
}

export const ruleMatches = (rule: GateRule, target: Target): boolean =>
  globMatches(rule.tool, target.tool) && globMatches(rule.effect, target.effect) && globMatches(rule.scope, target.scope);

/** The first matching rule of a behavior, so a deny is found before any ask or allow is looked at. */
export const firstMatch = (rules: readonly GateRule[], behavior: Behavior, target: Target): GateRule | undefined =>
  rules.find((r) => r.behavior === behavior && ruleMatches(r, target));
