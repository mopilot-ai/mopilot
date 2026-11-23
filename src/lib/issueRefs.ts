// Issue and pull request references in message prose (#123, owner/repo#123) as links to the chat's repository, as Claude Desktop links them.
import type { Link, Nodes, Parent, Root, Text } from 'mdast';

/** A repository a reference can link into. */
export interface IssueRepo {
  host: string;
  owner: string;
  repo: string;
}

/** The repository a git remote names, on a host whose issue URLs are known (GitHub or GitLab), else null. */
export function repoFromRemote(remote: string | null | undefined): IssueRepo | null {
  const m =
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(remote?.trim() ?? '') ??
    /^[^@\s]+@([^:/\s]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote?.trim() ?? '');
  if (!m) return null;
  // an ssh config alias for a second account (git@github.com-work:o/r) is still GitHub
  const host = m[1]
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/^github\.com-[\w.-]+$/, 'github.com');
  if (host !== 'github.com' && !host.includes('gitlab')) return null;
  return { host, owner: m[2], repo: m[3] };
}

/** The URL of issue or pull request `num` in `repo`. */
export function issueRefUrl({ host, owner, repo }: IssueRepo, num: string, pr: boolean) {
  const kind = host.includes('gitlab') ? (pr ? '-/merge_requests' : '-/issues') : pr ? 'pull' : 'issues';
  return `https://${host}/${owner}/${repo}/${kind}/${num}`;
}

const PR = String.raw`PR|pull[\s-]request|MR|merge[\s-]request`;
const KEYWORD_TAIL = String.raw`s?[\s:]+[(\[]?`;
/** A word right before #N that makes it a reference: "issue #12", "fixes #12", "merged #12". */
const KEYWORD = new RegExp(
  String.raw`\b(?:` +
    [
      `issue|bug|ticket|${PR}|gh`,
      String.raw`close[sd]?|fix(?:e[sd])?|resolve[sd]?`,
      String.raw`open(?:s|ed|ing)|created|merged?|merging|land(?:s|ed|ing)?|drafted`,
      String.raw`ship(?:ped|ping)?|rebased?`,
      String.raw`reopen(?:ed)?|revert(?:ed|ing)?|cherry[-\s]?pick(?:ed)?`,
      String.raw`stamped|approved?|review(?:ed|ing)?|filed|supersede[sd]?`,
      String.raw`babysit(?:ting)?|watching|confirm(?:s|ed)|ref(?:erence[sd]?)?`,
    ].join('|') +
    `)${KEYWORD_TAIL}$`,
  'i',
);
/** Where a "PR"/"pull request" keyword ends, so the reference right after it links to the pull request. */
const PR_KEYWORD = new RegExp(String.raw`\b(?:${PR})${KEYWORD_TAIL}`, 'gi');
/**
 * A neutral lead-in that lets a number of 3+ digits read as a reference: a line start, "(", a preposition, a list or
 * sentence mark, or (unlike Claude Desktop, whose rules are English) a CJK character (Chinese, Japanese or Korean prose before #N).
 */
const NEUTRAL =
  /(?:^\s*|\(|\b(?:on|in|for|of|via|at|by|per|about|since|after|before)\s+|[-\u2014\u2022*:.,\n]\s*|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]\s*)$/iu;
const MIN_DIGITS = 3;
/** What joins a list of references ("#12, #13 and #14"), and how far it may run. */
const LIST_JOIN = /^[\s,]*(?:[,/&]|\band\b|\bor\b)\s*$/i;
const LIST_GAP = 20;
/** A number with a leading zero (#000) is a color or a code, not an issue. */
const LEADING_ZERO = /^0/;
/** A color property right before a lead-in: "color: #333333" is a color. */
const COLOR = /\b(?:colou?r|background|bg|fill|stroke|border|hex)\b[^\n#]{0,12}$/i;
/** Words that pair with a slash in prose ("and/or#12"), never a repository owner. */
const NOT_OWNERS = new Set(['and', 'or', 'nor', 'yes', 'no', 'on', 'off', 'in', 'out', 'read', 'write', 'true', 'false']);
/** Whether owner/repo#N names a repository, not a file (src/foo.ts#12) or a word pair (and/or#12). */
const slashRepo = (owner: string, repo: string) => !NOT_OWNERS.has(owner.toLowerCase()) && !/\.[a-z0-9]{1,4}$/i.test(repo);
const SLASH_REF = /(?<![\w/])([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)#(\d+)\b/g;
const HASH_REF = /(?<![\w&])#(\d+)\b/g;
const ISSUE_URL = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/(issues|pull|-\/issues|-\/merge_requests)\/(\d+)\b/;
const ISSUE_URLS = /https?:\/\/[^/\s)]+\/[^/\s)]+\/[^/\s)]+\/(?:issues|pull|-\/issues|-\/merge_requests)\/\d+\b/g;
/**
 * "owner/repo issue #N", "`owner/repo` PR #N": a repository named right before the keyword. Unlike Claude Desktop, a
 * bare name ("site-docs issue #7") is no hint: hyphenated words before "issue" are mostly labels (main-red, fixes-main).
 */
const REPO_HINT = new RegExp(
  String.raw`(?<!\S)[(\[\x60"']*([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)[)\]\x60"']*(?:['\u2019]s)?[ \t]+(?:issue|bug|ticket|${PR})${KEYWORD_TAIL}$`,
  'i',
);

/** The owner/repo named right before a keyword (or as the inline code before the text), or null. */
function repoHint(before: string, code: string | undefined, base: IssueRepo): IssueRepo | null {
  const text = code !== undefined && code.length < 200 && /^\S+$/.test(code) ? `\`${code}\`${before}` : before;
  const m = REPO_HINT.exec(text.slice(text.lastIndexOf('\n') + 1));
  return m && slashRepo(m[1], m[2]) ? { ...base, owner: m[1], repo: m[2] } : null;
}

/** Where each "PR"-style keyword in `text` ends. */
function prKeywordEnds(text: string) {
  const ends = new Set<number>();
  for (const m of text.matchAll(PR_KEYWORD)) ends.add(m.index + m[0].length);
  return ends;
}

/** A reference number the message already names with its repository, or null when it names it with two. */
export type KnownRefs = Map<string, string | null>;

/**
 * The issue and pull request numbers a message names with a full URL or as owner/repo#N, each with its URL; a number
 * named with two different URLs is ambiguous (null). A bare #N with that number links there.
 */
export function knownRefs(text: string, repo: IssueRepo | null): KnownRefs {
  const known: KnownRefs = new Map();
  const learn = (num: string, url: string) => {
    const seen = known.get(num);
    if (seen === undefined) known.set(num, url);
    else if (seen !== null && seen.toLowerCase() !== url.toLowerCase()) known.set(num, null);
  };
  for (const [href] of text.matchAll(ISSUE_URLS)) {
    const m = ISSUE_URL.exec(href)!;
    const host = m[1].toLowerCase().replace(/^www\./, '');
    if (host !== 'github.com' && host !== repo?.host) continue;
    learn(m[5], issueRefUrl({ host, owner: m[2], repo: m[3] }, m[5], m[4] === 'pull' || m[4] === '-/merge_requests'));
  }
  const prEnds = prKeywordEnds(text);
  for (const m of text.matchAll(SLASH_REF)) {
    if (slashRepo(m[1], m[2]))
      learn(m[3], issueRefUrl({ host: repo?.host ?? 'github.com', owner: m[1], repo: m[2] }, m[3], prEnds.has(m.index)));
  }
  return known;
}

interface Found {
  start: number;
  end: number;
  url: string;
}

/**
 * The references in one run of plain text, in order. `emphasized` is set inside bold, italics and headings, where a
 * short number (step #2) is not linked; `code` is the inline code right before the text, which can name the repository.
 */
export function findIssueRefs(
  text: string,
  { repo, known, emphasized = false, code }: { repo: IssueRepo | null; known: KnownRefs; emphasized?: boolean; code?: string },
): Found[] {
  const found: Found[] = [];
  const prEnds = prKeywordEnds(text);
  for (const m of text.matchAll(SLASH_REF)) {
    if (!slashRepo(m[1], m[2])) continue;
    const pr = prEnds.has(m.index);
    found.push({
      start: m.index,
      end: m.index + m[0].length,
      url: issueRefUrl({ host: repo?.host ?? 'github.com', owner: m[1], repo: m[2] }, m[3], pr),
    });
  }
  // the previous #N's end and decisions, which a list ("#12, #13 and #14") carries on
  let lastEnd = 0;
  let lastLinked = false;
  let lastPr = false;
  let lastHint: IssueRepo | null = null;
  for (const m of text.matchAll(HASH_REF)) {
    const num = m[1];
    const listed = lastEnd > 0 && m.index - lastEnd <= LIST_GAP && LIST_JOIN.test(text.slice(lastEnd, m.index));
    const afterSlash = text[m.index - 1] === '/';
    if (afterSlash && !listed) continue;
    const short = (emphasized && num.length < MIN_DIGITS) || LEADING_ZERO.test(num);
    const carried: boolean = lastLinked && listed;
    const before = afterSlash ? '' : text.slice(Math.max(0, m.index - 256), m.index);
    const linked: boolean =
      !short &&
      (carried || (!afterSlash && (KEYWORD.test(before) || (num.length >= MIN_DIGITS && NEUTRAL.test(before) && !COLOR.test(before)))));
    const pr: boolean = carried ? lastPr : !afterSlash && prEnds.has(m.index);
    const hint: IssueRepo | null = carried ? lastHint : linked && repo ? repoHint(before, code, repo) : null;
    lastEnd = m.index + m[0].length;
    lastLinked = linked;
    lastPr = pr;
    lastHint = hint;
    // a number the message names with two repositories links to neither, nor to a third
    const url = known.has(num) ? known.get(num) : linked && repo ? issueRefUrl(hint ?? repo, num, pr) : null;
    if (url && !short) found.push({ start: m.index, end: lastEnd, url });
  }
  found.sort((a, b) => a.start - b.start);
  let end = 0;
  return found.filter((f) => (f.start < end ? false : ((end = f.end), true)));
}

/** Marks a link node as an issue reference, so the view renders it as a plain link rather than a pull request chip. */
export const ISSUE_REF_PROPERTY = 'data-issue-ref';

function refLink(url: string, value: string): Link {
  return { type: 'link', url, children: [{ type: 'text', value }], data: { hProperties: { [ISSUE_REF_PROPERTY]: '' } } };
}

const EMPHASIS = new Set(['strong', 'emphasis', 'heading']);
const SKIP = new Set(['link', 'linkReference', 'code', 'inlineCode', 'html', 'math', 'inlineMath', 'definition']);

/** A remark plugin that links the references in a message's prose (not in code or existing links). */
export function remarkIssueRefs({ repo, known }: { repo: IssueRepo | null; known: KnownRefs }) {
  const visit = (parent: Parent, emphasized: boolean) => {
    const children: Nodes[] = [];
    for (const [i, child] of (parent.children as Nodes[]).entries()) {
      if (child.type === 'text') {
        const prev = i > 0 ? (parent.children[i - 1] as Nodes) : undefined;
        const refs = findIssueRefs(child.value, { repo, known, emphasized, code: prev?.type === 'inlineCode' ? prev.value : undefined });
        let at = 0;
        for (const ref of refs) {
          if (ref.start > at) children.push({ type: 'text', value: child.value.slice(at, ref.start) } as Text);
          children.push(refLink(ref.url, child.value.slice(ref.start, ref.end)));
          at = ref.end;
        }
        if (at === 0) children.push(child);
        else if (at < child.value.length) children.push({ type: 'text', value: child.value.slice(at) } as Text);
        continue;
      }
      if ('children' in child && !SKIP.has(child.type)) visit(child, emphasized || EMPHASIS.has(child.type));
      children.push(child);
    }
    parent.children = children as Parent['children'];
  };
  return (tree: Root) => visit(tree, false);
}
