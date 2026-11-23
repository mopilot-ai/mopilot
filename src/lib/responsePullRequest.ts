// Conservative PR identity and reported status inference from completed assistant prose, shared by every harness.
import { parseMarkdown } from '../../shared/markdownParse.mjs';
import { movedMopilotPullRequestUrl, pullRequestUrl, recordedBeforeMopilotReuse } from '../../shared/pullRequest.mjs';
import { PROSE_LINK, splitLinks } from '../../shared/proseLinks.mjs';
import type { ThreadPullRequest, PullRequestState } from './threadPullRequest';
import { memoByObject } from './memoByObject';

export interface ResponseTurn {
  status: string;
  completedAt?: number | null;
  items: { type: string; text?: string; phase?: string | null }[];
}
interface ProseNode {
  type: string;
  value?: string;
  url?: string;
  children?: ProseNode[];
}

interface ProseReference {
  url: string;
  start: number;
  end: number;
}
interface ProseScope {
  text: string;
  urls: Set<string>;
  directMerge: boolean;
  referencesOnly: boolean;
  structured: boolean;
  deliveryUrl?: string;
  withdrawal?: string;
}
const cleanProse = (text: string) =>
  text
    .replace(PROSE_LINK, '')
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .trim();
const restoreInlineTokens = (text: string, from: number, inlineTokens: ReadonlyMap<number, string>) =>
  text.replace(/\uFFFC/g, (placeholder, offset: number) => inlineTokens.get(from + offset) ?? placeholder);
const SENTENCE_BOUNDARY = /(?<=[.!?;])\s+|\n+/g;
/** An explicit conditional introduction applies to its following Markdown block. */
const CONDITIONAL_LEAD_IN = /^(?:only\s+)?(?:if|when|once|until|unless)\b.*:$/i;

function introducesConditionalBlock(text: string): boolean {
  const prose = text.trim();
  if (!prose.endsWith(':')) return false;
  // Parenthetical details and abbreviations stay in the clause. An ellipsis can continue it or end the sentence.
  const lastClause = prose
    .replace(/\((?:[^()]|\([^()]*\))*\)/g, ' ')
    .replace(/\b(?:[a-z]\.){2,}/gi, ' ')
    .replace(/(?:\.{2,}|…)(?=\s+[^\p{L}\p{N}]*(?:\p{Lu}|actual result:))/gu, '.')
    .replace(/(?:\.{2,}|…)/g, ' ')
    .split(SENTENCE_BOUNDARY)
    .at(-1)!;
  return CONDITIONAL_LEAD_IN.test(lastClause);
}

/** A merge statement can name its PR by a plain link or by the short or repository-qualified label of that link. */
function linkedMergeStatement(
  content: string,
  from: number,
  refs: readonly ProseReference[],
  inlineTokens: ReadonlyMap<number, string>,
): string | null {
  const [subject, citation] = refs;
  const before = content.slice(0, subject.start - from);
  if (!/\bmerged(?:\s+via)?\s+$/i.test(before)) return null;
  const number = subject.url.split('/').at(-1);
  const matchingLabels = refs.every((ref) => {
    const [, , , owner, repo] = ref.url.split('/');
    const label = content
      .slice(ref.start - from, ref.end - from)
      .trim()
      .toLowerCase()
      .replace(/^(?:pr|pull request)\s*(?=#)/, '');
    return label === `${owner}/${repo}#${number}` || label === `#${number}` || pullRequestUrl(label) === ref.url;
  });
  if (!matchingLabels) return null;
  let end = content.length;
  let punctuation = '';
  // A short parenthetical can repeat the primary link after the verification.
  if (citation) {
    const opening = /\s+\(see\s+$/i.exec(content.slice(0, citation.start - from));
    const closing = /^\s*\)\s*([.!?]*)\s*$/.exec(content.slice(citation.end - from));
    if (!opening || !closing) return null;
    end = opening.index;
    punctuation = closing[1];
  }
  const after = restoreInlineTokens(content.slice(subject.end - from, end), subject.end, inlineTokens);
  return `${before}PR #${number}${after}${punctuation}`;
}

function prose(text: string, historical: boolean) {
  const identity = (url: string) => (historical ? movedMopilotPullRequestUrl(url) : url);
  let rendered = '';
  const references: ProseReference[] = [];
  const blocks: { start: number; end: number; deliveryUrl?: string }[] = [];
  const conditionalBlocks: { start: number; end: number }[] = [];
  const inlineTokens = new Map<number, string>();
  const reference = (url: string | null, start: number) => {
    if (!url) return;
    if (rendered.length === start) rendered += url;
    references.push({ url, start, end: rendered.length });
  };
  const neutralReference = (r: ProseReference) =>
    /^(?:(?:the\s+)?(?:PR|pull request)(?:\s*#\d+)?|#\d+|[\w.-]+\/[\w.-]+#\d+)?$/i.test(cleanProse(rendered.slice(r.start, r.end)));
  const visit = (node: ProseNode, links = true): void => {
    const blockStart = rendered.length;
    // Keep the code delimiters so only recognized fields can consume these tokens.
    if (node.type === 'inlineCode' && /^(?:[\w./-]+|#\d+)$/.test(node.value!)) inlineTokens.set(blockStart, `\`${node.value}\``);
    if (['inlineCode', 'code', 'blockquote', 'html', 'image', 'definition', 'delete'].includes(node.type)) {
      rendered += '￼';
      return;
    }
    if (node.type === 'link') {
      const start = rendered.length;
      for (const child of node.children!) visit(child, false);
      reference(pullRequestUrl(node.url), start);
      return;
    }
    if (node.type === 'break') {
      rendered += ' ';
      return;
    }
    if (node.type === 'text') {
      const value = node.value!.replace(/\s*\n\s*/g, ' ');
      if (!links) {
        rendered += value;
        return;
      }
      for (const [i, part] of splitLinks(value).entries()) {
        const start = rendered.length;
        rendered += part;
        if (i % 2) reference(pullRequestUrl(part), start);
      }
      return;
    }
    let firstCellEnd = blockStart;
    let conditional = false;
    for (const [i, child] of (node.children ?? []).entries()) {
      if (child.type === 'thematicBreak') continue;
      const start = rendered.length;
      visit(child, links);
      if (conditional) conditionalBlocks.push({ start, end: rendered.length });
      conditional = (child.type === 'paragraph' || child.type === 'heading') && introducesConditionalBlock(rendered.slice(start));
      if (i === 0) firstCellEnd = rendered.length;
    }
    // A delivery table starts its row with a PR reference; descriptive citation labels supply no ownership.
    const cellRefs = node.type === 'tableRow' ? references.filter((r) => r.start >= blockStart && r.end <= firstCellEnd) : [];
    const cellPr = cellRefs.length === 1 ? cellRefs[0] : undefined;
    const deliveryUrl =
      cellPr &&
      neutralReference(cellPr) &&
      /^[\s()[\].,!;:'"]*$/.test(rendered.slice(blockStart, cellPr.start) + rendered.slice(cellPr.end, firstCellEnd))
        ? identity(cellPr.url)
        : undefined;
    // Structured delivery entries start with a PR number or an explicit numbered heading, not arbitrary list prose.
    if (
      deliveryUrl ||
      (['heading', 'listItem', 'paragraph'].includes(node.type) &&
        /^(?:(?:PR|pull request)\s*)?#\d+\b|^\d+\.\s/i.test(rendered.slice(blockStart)))
    )
      blocks.push({ start: blockStart, end: rendered.length, deliveryUrl });
    if (node.type === 'tableCell') rendered += ' ';
    if (['paragraph', 'heading', 'listItem', 'tableRow'].includes(node.type)) rendered += '\n';
  };
  visit(parseMarkdown(text));
  const scopes: ProseScope[] = [];
  let from = 0;
  // Split the complete rendered text, so punctuation in emphasis and whitespace outside it remain one boundary.
  for (const end of [...rendered.matchAll(SENTENCE_BOUNDARY)].map((m) => m.index).concat(rendered.length)) {
    const content = rendered.slice(from, end);
    const start = end - content.trimStart().length;
    if (conditionalBlocks.some((block) => block.start <= start && block.end >= end)) {
      from = end;
      continue;
    }
    const refs = references.filter((r) => r.start >= from && r.start < end);
    const urls = new Set(refs.map((r) => identity(r.url)));
    let ordinary = content;
    for (const ref of [...refs].reverse()) ordinary = ordinary.slice(0, ref.start - from) + ordinary.slice(ref.end - from);
    const neutral = refs.every(neutralReference);
    const block = blocks.find((b) => b.start <= start && b.end >= end);
    const mergeStatement = urls.size === 1 ? linkedMergeStatement(content, from, refs, inlineTokens) : null;
    const text = cleanProse(content);
    const correction =
      text.includes('\uFFFC') && /\b(?:did not|didn['’]t) merge\b/i.test(text)
        ? cleanProse(restoreInlineTokens(content, from, inlineTokens))
        : text;
    const withdrawal = WITHDRAWN_MERGE.exec(correction);
    scopes.push({
      // The full suffix must survive validation, including any question punctuation beside an autolink.
      text: mergeStatement ?? text,
      urls,
      // Only a complete statement can establish the commit verification. A semicolon can introduce a qualification.
      directMerge: mergeStatement !== null && !content.trimEnd().endsWith(';'),
      referencesOnly:
        refs.length > 0 && neutral && !content.trimEnd().endsWith('?') && /^[\s()[\].,!;:'"]*$/.test(ordinary.replace(/\band\b/gi, '')),
      structured: !!block,
      deliveryUrl: block?.deliveryUrl,
      withdrawal: withdrawal ? (withdrawal[1] ?? withdrawal[2] ?? '') : undefined,
    });
    // The separator itself contains only whitespace, so leaving it at the start of the next scope is harmless.
    from = end;
  }
  return { text: cleanProse(rendered), urls: new Set(references.map((r) => identity(r.url))), scopes };
}

/**
 * A finished reply's prose, parsed once per reply object: every refresh of a thread's pull request reads every reply,
 * and a long thread holds megabytes of them. The text is kept with the parse, so a reply changed in place parses again.
 */
const parsedReply = memoByObject((item: { text: string }) => ({ text: item.text, report: prose(item.text, false) }));
const parsedHistoricalReply = memoByObject((item: { text: string }) => ({ text: item.text, report: prose(item.text, true) }));
function replyProse(item: { text: string }, historical: boolean) {
  const parsed = historical ? parsedHistoricalReply(item) : parsedReply(item);
  return parsed.text === item.text ? parsed.report : prose(item.text, historical);
}

/** An explicit example/plan heading, which can govern assertions in later paragraphs. */
const EXAMPLE =
  /\b(?:example|expected|planned|hypothetical|sample|suggested|future)\s+(?:response|reply|message|output)\b|\b(?:response|reply|message)\s+(?:template|example)\b|\b(?:will|would|should|could|plan to)\s+(?:say|reply|respond|report|write)\b/i;
/** A question or a condition, which asserts nothing. */
const UNASSERTED = /\?[\s)\]}"'’”]*$|\b(?:if|when|once|until|would|should|could|might|must)\b/i;
const WITHDRAWAL_REASON = String.raw`(?:\s+because\s+[^!?;]+)?`;
/** A following correction can withdraw a verification claim. */
const WITHDRAWN_MERGE = new RegExp(
  String.raw`^(?:(?:correction:|actually,)\s*)?(?:` +
    String.raw`no (?:actual )?merge (?:was|has been) performed${WITHDRAWAL_REASON}[.!;]*|` +
    String.raw`(?:I|we) (?:did not|didn['’]t) (?:actually )?merge(?: (?:it|(?:(?:the|this) )?(?:PR|pull request)(?:\s*(?:#(\d+)|\x60#(\d+)\x60))?))?[.!]*|` +
    String.raw`(?:(?:this|it) (?:was|is) (?:only |just )?a dry run|(?:but )?only in a dry run)${WITHDRAWAL_REASON}[.!;]*)$`,
  'i',
);
const BRANCH = String.raw`(?:remote\s+)?(?:[\w./-]+|\x60[\w./-]+\x60)`;
const HASH = String.raw`(?:[\da-f]{4,64}|\x60[\da-f]{4,64}\x60)`;
const CONTAINED_COMMIT = String.raw`(?:the\s+)?(?:(?:fix|merge)\s+)?commit\s+${HASH}`;
/** A linked merge can name its destination and verify which commits are there. Match the entire suffix. */
const LINKED_MERGE_DETAILS = new RegExp(
  String.raw`(\bPR #\d+)(?:\s+into\s+(?:remote\s+)?(?:main|master|\x60[\w./-]+\x60))?` +
    String.raw`(?:\s+and\s+(?:(?:I|we)\s+)?(?:verified|confirmed)\s+(?:` +
    String.raw`(?:the\s+)?(?:merge\s+)?commit(?:\s+${HASH})?\s+(?:is|was)\s+(?:on|in)\s+${BRANCH}|` +
    String.raw`(?:that\s+)?it\s+contains\s+${CONTAINED_COMMIT}(?:\s+and\s+${CONTAINED_COMMIT})*))?$`,
  'i',
);
/** A reply's sentences that assert something, without their closing punctuation; none under an example heading. */
const assertions = (text: string, directMerge = false) =>
  EXAMPLE.test(text)
    ? []
    : text
        .split(SENTENCE_BOUNDARY)
        // A clause trailing off at an ellipsis may be qualified by the next one.
        .filter((sentence) => !directMerge || !/(?:\.{2,}|…)\s*$/.test(sentence))
        .map((sentence) => {
          const value = sentence
            .trim()
            .replace(/[.!;]+$/, '')
            .trim();
          // Branch names can contain words like "when" without making the merge conditional.
          return directMerge ? value.replace(LINKED_MERGE_DETAILS, '$1') : value;
        })
        .filter((value) => !UNASSERTED.test(value));

function reportedState(text: string, directMerge = false): PullRequestState | null {
  let state: PullRequestState | null = null;
  for (const value of assertions(text, directMerge)) {
    if (
      /\bnot (?:yet )?merged\b|\b(?:labeled|labelled|queued|marked)\s+(?:as\s+)?merge-on-green\b|\b(?:will merge|waiting to merge)\b/i.test(
        value,
      )
    )
      state = 'open';
    else if (
      /^(?:(?:I|we)\s+(?:have\s+)?)?(?:committed and\s+)?(?:successfully\s+)?merged(?:\s+(?:via\s+)?(?:PR|pull request)(?:\s*#\d+)?)?(?:\s+into (?:main|master))?$/i.test(
        value,
      ) ||
      /^(?:the\s+)?(?:PR|pull request)(?:\s*#\d+)?\s+(?:(?:is|was|has been)\s+)?(?:successfully\s+)?merged(?:\s+into (?:main|master))?$/i.test(
        value,
      )
    )
      state = 'merged';
    else if (/^(?:the\s+)?(?:PR|pull request)(?:\s*#\d+)?\s+(?:is|was|has been)\s+closed\b|^closed\s+(?:PR|pull request)\b/i.test(value))
      state = 'closed';
    else if (
      /\b(?:opened|created)\s+(?:a\s+)?draft\s+(?:PR|pull request)\b|^(?:the\s+)?(?:PR|pull request)(?:\s*#\d+)?\s+is\s+(?:a\s+)?draft\b/i.test(
        value,
      )
    )
      state = 'draft';
    else if (
      /\b(?:opened|created|reopened)\s+(?:PR|pull request)\b|^(?:the\s+)?(?:PR|pull request|it)(?:\s*#\d+)?\s+(?:is\s+(?:still\s+)?|remains\s+)open\b/i.test(
        value,
      )
    )
      state = 'open';
  }
  return state;
}

const COUNT = String.raw`(both|two|three|four|five|\d+)`;
const PRS = String.raw`(?:(?:the|of the)\s+)?(?:PRs|pull requests)`;
const OPENED = new RegExp(String.raw`^(?:I|we)(?:'ve|\s+have)?\s+(?:opened|created)\s+${COUNT}\s+(draft\s+)?${PRS}\b`, 'i');
const ALL_MERGED = new RegExp(String.raw`^(?:all|both)\s+(?:${COUNT}\s+)?${PRS}\s+(?:are|were|have been)\s+(?:now\s+)?merged\b`, 'i');
const MERGED_ALL = new RegExp(String.raw`^(?:I|we)\s+(?:have\s+)?merged\s+(?:all|${COUNT})\s+${PRS}\b`, 'i');
const NEITHER_MERGED = /^neither\s+(?:PR|pull request)\s+(?:is|was|has been)\s+(?:yet\s+)?merged\b/i;
const NUMBERS: Record<string, number> = { both: 2, two: 2, three: 3, four: 4, five: 5 };
const countOf = (word: string | undefined) => (word ? (NUMBERS[word.toLowerCase()] ?? Number(word)) : null);

/**
 * A state a reply asserts of several PRs at once ("I've opened two PRs", "Both PRs are merged", "Neither PR is merged
 * yet"), with how many it says there are (null for "all"); the latest assertion wins.
 */
function pluralState(text: string): { state: PullRequestState; count: number | null } | null {
  let result: { state: PullRequestState; count: number | null } | null = null;
  for (const value of assertions(text)) {
    const opened = OPENED.exec(value);
    const merged = ALL_MERGED.exec(value) ?? MERGED_ALL.exec(value);
    if (opened) result = { state: opened[2] ? 'draft' : 'open', count: countOf(opened[1]) };
    else if (merged) result = { state: 'merged', count: countOf(merged[1] ?? (/^both\b/i.test(value) ? 'both' : undefined)) };
    else if (NEITHER_MERGED.test(value)) result = { state: 'open', count: 2 };
  }
  return result;
}

type Reply = { type: string; text: string; phase?: string | null };
/** A finished reply's prose (not commentary): the only items responsePullRequests reads. */
const isReply = (item: ResponseTurn['items'][number] | null | undefined): item is Reply =>
  item?.type === 'agentMessage' && typeof item.text === 'string' && !!item.text && item.phase !== 'commentary';

/**
 * Only the replies that can change what responsePullRequests finds: one that links a PR, mentions a PR number or reports
 * a state. Any other reply passes through it without effect, so a chat's saved replies can be kept as these few.
 */
export function pullRequestReplies(turns: readonly ResponseTurn[]): ResponseTurn[] {
  if (!Array.isArray(turns)) return [];
  const kept: ResponseTurn[] = [];
  for (const turn of turns) {
    if (turn?.status !== 'completed' || !Array.isArray(turn.items)) continue;
    const historical = recordedBeforeMopilotReuse(turn.completedAt);
    const items = turn.items.filter((item: ResponseTurn['items'][number]) => {
      if (!isReply(item)) return false;
      const report = replyProse(item, historical);
      return (
        report.urls.size > 0 ||
        /\b(?:PR|pull request)\s*#\d+/i.test(report.text) ||
        reportedState(report.text) !== null ||
        pluralState(report.text) !== null
      );
    });
    if (items.length) {
      const { completedAt } = turn;
      kept.push({ status: 'completed', items, ...(completedAt == null ? {} : { completedAt }) });
    }
  }
  return kept;
}

/**
 * Every PR an unambiguous completed lifecycle report identifies, most recent first. Citations alone supply no identity.
 * A reply
 * may update its own single PR, or a previously identified PR; multiple identities are ambiguous, unless the reply says
 * what happened to all of them ("I've opened two PRs" with their two links, "Both PRs are merged" naming #N of PRs the
 * chat already identified).
 */
export function responsePullRequests(
  turns: readonly ResponseTurn[],
  knownUrl?: string | null,
  attachments: readonly string[] = [],
): ThreadPullRequest[] {
  const reported = new Map<string, ThreadPullRequest>();
  /** The chat's PRs by number. An attachment may make a number ambiguous before either PR has a report. */
  const byNumber = new Map<string, Set<string>>();
  const numbered = (number: string) => {
    const urls = byNumber.get(number);
    const url = urls?.size === 1 ? urls.values().next().value : undefined;
    return url && reported.has(url) ? url : undefined;
  };
  const remember = (url: string) => {
    const number = url.split('/').at(-1)!;
    const urls = byNumber.get(number) ?? new Set<string>();
    urls.add(url);
    byNumber.set(number, urls);
  };
  const report = (url: string, state: PullRequestState) => {
    // re-inserted, so the map runs from the oldest report to the latest
    reported.delete(url);
    reported.set(url, { url, number: Number(url.split('/').at(-1)), state, source: 'response' });
    remember(url);
  };
  let currentUrl = pullRequestUrl(knownUrl);
  if (currentUrl) remember(currentUrl);
  attachments.forEach(remember);
  if (!Array.isArray(turns)) return [];
  for (const turn of turns) {
    if (turn?.status !== 'completed' || !Array.isArray(turn.items)) continue;
    const historical = recordedBeforeMopilotReuse(turn.completedAt);
    for (const item of turn.items) {
      if (!isReply(item)) continue;
      const parsed = replyProse(item, historical);
      const plural = pluralState(parsed.scopes.map((scope) => scope.text).join('\n'));
      // the PRs it links, and the ones the chat already found that it names as #N
      const several = [
        ...new Set([...parsed.urls, ...[...parsed.text.matchAll(/(?<![\w/&])#(\d+)\b/g)].flatMap((m) => numbered(m[1]) ?? [])]),
      ];
      // Keep the whole-reply ambiguity/count guard, but only deliver links/numbers from the report's own scopes.
      const targets = new Set(
        parsed.scopes
          .filter((s) => pluralState(s.text) || ((s.referencesOnly || s.structured) && !UNASSERTED.test(s.text)))
          .flatMap((s) =>
            s.deliveryUrl
              ? [s.deliveryUrl]
              : [...s.urls, ...[...s.text.matchAll(/(?<![\w/&])#(\d+)\b/g)].flatMap((m) => numbered(m[1]) ?? [])],
          ),
      );
      if (plural && several.length > 1 && targets.size === several.length && (plural.count === null || plural.count === several.length)) {
        for (const url of several) report(url, plural.state);
        currentUrl = null;
        continue;
      }
      if (parsed.urls.size > 1) {
        currentUrl = null;
        continue;
      }
      if (EXAMPLE.test(parsed.text)) {
        if ([...parsed.urls].some((u) => u !== currentUrl)) currentUrl = null;
        continue;
      }
      const neutral = parsed.scopes.filter((s) => s.referencesOnly);
      const delivery = new Set(neutral.flatMap((s) => [...s.urls]));
      for (const [i, scope] of parsed.scopes.entries()) {
        const following = parsed.scopes.slice(i + 1);
        const after = following.find((s) => s.text || s.urls.size);
        const state = reportedState(scope.text, scope.directMerge);
        const mentions = [...scope.text.matchAll(/\b(?:PR|pull request)\s*#(\d+)/gi)];
        const number = state && mentions[0]?.[1];
        const named = number ? (numbered(number) ?? [...delivery].find((u) => u.endsWith(`/${number}`))) : undefined;
        // A standalone delivery link can follow the status; a background sentence or descriptive link cannot.
        const next = state && after?.referencesOnly && after.urls.size === 1 ? after.urls.values().next().value : undefined;
        const linked = scope.urls.values().next().value ?? next;
        if (!linked && number && (byNumber.get(number)?.size ?? 0) > 1) {
          currentUrl = null;
          continue;
        }
        const url: string | null = linked ?? named ?? currentUrl;
        if (!url) continue;
        if (historical && movedMopilotPullRequestUrl(url) !== url) {
          currentUrl = null;
          continue;
        }
        if (mentions.some((m) => m[1] !== url.split('/').at(-1))) {
          currentUrl = null;
          continue;
        }
        // A named PR elsewhere in the reply may contradict a newly inferred identity, even after a correction clause.
        const mismatched = [...parsed.text.matchAll(/\b(?:PR|pull request)\s*#(\d+)/gi)].some((m) => m[1] !== url.split('/').at(-1));
        if (state && scope.urls.size && url !== currentUrl && mismatched) {
          currentUrl = null;
          continue;
        }
        if (state) {
          const withdrawal = state === 'merged' ? following.find((s) => s.text && !s.referencesOnly)?.withdrawal : undefined;
          if (withdrawal !== undefined && (!withdrawal || url.endsWith(`/${withdrawal}`))) {
            currentUrl = url;
            continue;
          }
          report(url, state);
          currentUrl = url;
        } else if (scope.urls.size) currentUrl = url === currentUrl ? url : null;
      }
    }
  }
  return [...reported.values()].reverse();
}

/** The PR the chat's replies identified last, with its reported state. */
export function responsePullRequest(turns: readonly ResponseTurn[], knownUrl?: string | null): ThreadPullRequest | null {
  return responsePullRequests(turns, knownUrl)[0] ?? null;
}
