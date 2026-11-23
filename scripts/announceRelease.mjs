// Announces a new stable Mac release in the Discord #announcements channel through a webhook.
//   node scripts/announceRelease.mjs --after <stable.json after the push> --before <an earlier stable.json> [--before …]
// .github/release-repo/announce-stable.yml runs it on every push of updates/stable.json to the release repository, which
// every way a stable build goes public ends in (a promotion, a rollout change, a hand edit). It posts once, when the feed's
// newest fully rolled-out Mac version is higher than in every earlier feed it is given (the whole history of the file), which
// is when /download starts serving it; a rollout change, a pause and resume, a withdrawal or a rollback posts nothing.
// Env: DISCORD_RELEASE_WEBHOOK_URL (absent: it does nothing, so a fork never posts). It never throws and never retries,
// so a failure costs one missed post and never a doubled one; the webhook URL is never printed.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DOWNLOAD_URL = 'https://mopilot.ai/download';
const WEBHOOK = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const MAX_HIGHLIGHTS = 6;
const MAX_LINE = 140;

/** [major, minor, patch], or null when it is no plain version: a build of the earlier tagged scheme (0.4.11-dogfood.27) never announces. */
function rank(version) {
  const m = VERSION.exec(typeof version === 'string' ? version : '');
  return m ? [+m[1], +m[2], +m[3]] : null;
}

const higher = (a, b) => {
  const i = a.findIndex((n, k) => n !== b[k]);
  return i >= 0 && a[i] > b[i];
};

/** The live Mac builds of a stable feed: its macOS entries rolled out to 100%, which is what /download serves. */
function liveMacBuilds(feed) {
  const lists = [feed?.releases, feed?.promotions].map((l) => (Array.isArray(l) ? l : []));
  return lists.flat().filter((r) => r && r.platform === 'darwin' && rank(r.version) && r.rolloutPct === 100);
}

/** The highest live Mac build of a feed: { version, notes }, or null when it has none. */
function newest(feed) {
  /** @type {{ version: string, notes: string } | null} */
  let best = null;
  for (const r of liveMacBuilds(feed))
    if (!best || higher(rank(r.version), rank(best.version)))
      best = { version: r.version, notes: typeof r.notes === 'string' ? r.notes : '' };
  return best;
}

/** The release `after` adds to the earlier feeds `before`: its newest live Mac build when that is a higher version than any of theirs, else null. */
export function addedRelease(before, after) {
  const now = newest(after);
  const was = newest({ releases: [before].flat().flatMap((feed) => liveMacBuilds(feed)) });
  return now && (!was || higher(rank(now.version), rank(was.version))) ? now : null;
}

/** Text of a note without its Markdown: link text instead of links, no emphasis or code marks. */
function plain(text) {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Up to six short lines from release notes: their bullets, or else the bold lead of each paragraph; never a catch-all "Other fixes". */
export function highlights(notes) {
  const lines = String(notes ?? '').split('\n');
  let items = lines.filter((l) => /^\s*[-*•]\s+\S/.test(l)).map((l) => l.replace(/^\s*[-*•]\s+/, ''));
  if (!items.length) items = lines.map((l) => /^\s*\*\*([^*]+?)\*\*/.exec(l)?.[1] ?? '').filter(Boolean);
  return items
    .map(plain)
    .map((s) => s.replace(/[.:]$/, ''))
    .filter((s) => s && !/^other (?:fixes|changes|improvements)\b/i.test(s))
    .slice(0, MAX_HIGHLIGHTS)
    .map((s) => {
      const chars = [...s];
      return chars.length > MAX_LINE
        ? `${chars
            .slice(0, MAX_LINE - 1)
            .join('')
            .trimEnd()}…`
        : s;
    });
}

/** The webhook's JSON body: "MoPilot <version> is out", the highlights and the download link. No mention can ping anyone. */
export function buildAnnouncement(release) {
  const bullets = highlights(release.notes).map((s) => `• ${s}`);
  const content = [
    `**MoPilot ${release.version} is out**`,
    ...(bullets.length ? ['', ...bullets] : []),
    '',
    `Download: ${DOWNLOAD_URL}`,
  ].join('\n');
  return { content, allowed_mentions: { parse: [] } };
}

const readFeed = (file) => {
  try {
    const feed = JSON.parse(readFileSync(file, 'utf8'));
    return feed && typeof feed === 'object' ? feed : {};
  } catch {
    return {};
  }
};

/**
 * Posts the announcement when `after` adds a release to `before`. Returns what happened, for the log: 'no-webhook',
 * 'invalid-webhook', 'nothing-new', `posted <version>` or `failed <why>`; the URL never appears in it.
 * @param {{ before: unknown, after: unknown, webhook?: string, post?: (url: string, init: any) => Promise<{ ok: boolean, status?: number }> }} o
 */
export async function announce({ before, after, webhook, post = fetch }) {
  if (!webhook) return 'no-webhook';
  if (!WEBHOOK.test(webhook)) return 'invalid-webhook';
  const release = addedRelease(before, after);
  if (!release) return 'nothing-new';
  try {
    const res = await post(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildAnnouncement(release)),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok ? `posted ${release.version}` : `failed HTTP ${res.status}`;
  } catch (e) {
    return `failed ${e?.name === 'TimeoutError' ? 'timeout' : 'request'}`;
  }
}

/** The value after `--name` in `argv`, or ''. */
const flag = (argv, name) => (argv.includes(name) ? (argv[argv.indexOf(name) + 1] ?? '') : '');

/** Runs the command line; always returns 0 so a failed post never fails the workflow that ran it. */
export async function main(argv, env, log = console.log) {
  const result = await announce({
    before: argv.flatMap((a, i) => (a === '--before' ? [readFeed(argv[i + 1] ?? '')] : [])),
    after: readFeed(flag(argv, '--after')),
    webhook: env.DISCORD_RELEASE_WEBHOOK_URL,
  });
  if (result !== 'no-webhook') log(`Discord announcement: ${result}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exit(await main(process.argv.slice(2), process.env));
