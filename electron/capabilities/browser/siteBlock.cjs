// A site that refuses or rate-limits the in-app browser (#4651): the agent is told plainly, in one short line with the status, and does
// not hammer the page. Two parts, both honest and neither a way around the site's protection:
// - blockNote(): the note an HTTP 403 or 429 on a navigation gets, so a block page is never read as the page asked for.
// - SitePacing: a person's pace per site. Navigations to one site are at least GAP_MS apart, and after a block the site is left alone for
//   a cool-down that doubles on each further block (up to MAX_COOL_MS), during which a navigation to it is refused without loading it.
// No CAPTCHA is solved, no identity changes, and nothing is retried: the page stays for the user, who has Continue in Chrome.
const { ToolError } = require('../contract/registry.cjs');
const { sleep } = require('./hostUtil.cjs');

const GAP_MS = 1200;
const COOL_MS = 45_000;
const MAX_COOL_MS = 5 * 60_000;
/** The statuses a site answers a browser it will not serve (or serves too often) with. */
const BLOCK_STATUSES = new Set([403, 429]);

/**
 * The site an address belongs to for pacing, or '' for one that is not paced: an address with no host (about:, file:, data:) and the
 * machine's own and private network's (a dev server's 403 is its own answer, not a bot check). SAGE_E2E_PACE_LOCAL=1 paces them too,
 * for the E2E that serves its test site on 127.0.0.1.
 */
function pacedHost(url) {
  let host = '';
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') host = u.host;
  } catch {
    return '';
  }
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const local = /^(localhost|.*\.localhost|.*\.local|::1|127\.[\d.]+|10\.[\d.]+|192\.168\.[\d.]+|172\.(1[6-9]|2\d|3[01])\.[\d.]+)$/i.test(
    name,
  );
  return local && process.env.SAGE_E2E_PACE_LOCAL !== '1' ? '' : host;
}

/**
 * The HTTP status the tab's page was answered with: its newest document request (the tab's own network log, tab.cjs) for the
 * address now shown, or null when none was seen. Subframe documents and subresources are other addresses.
 * @param {{ url: string, network?: Map<string, { type: string, url: string, status: number | null }> }} tab
 */
function documentStatus(tab) {
  const here = String(tab.url).split('#')[0];
  /** @type {number | null} */
  let status = null;
  for (const r of tab.network?.values() ?? []) if (r.type === 'Document' && r.url.split('#')[0] === here) status = r.status;
  return status;
}

/**
 * The note for a page the site answered with a block status, or null (also for a site that is not paced). One line: the status, who
 * refused, what to do.
 * @param {number | null | undefined} status
 * @param {string} url
 */
function blockNote(status, url) {
  const host = pacedHost(url);
  if (!host || !BLOCK_STATUSES.has(Number(status))) return null;
  const what = status === 429 ? 'is rate-limiting this browser' : 'refused this browser';
  return `${host} answered HTTP ${status}: it ${what}, so the page shown may be its block page, not the page asked for. Do not retry now; tell the user, who can use Continue in Chrome.`;
}

class SitePacing {
  /** @param {{ now?: () => number, wait?: (ms: number) => Promise<unknown> }} [o] */
  constructor({ now = Date.now, wait = sleep } = {}) {
    this.now = now;
    this.wait = wait;
    /** host -> { last: when the last navigation to it starts, until: when its cool-down ends, cool: the next cool-down's length } */
    this.sites = new Map();
  }

  /** @param {string} host */
  #site(host) {
    let site = this.sites.get(host);
    if (!site) this.sites.set(host, (site = { last: -Infinity, until: 0, cool: COOL_MS, status: 0 }));
    return site;
  }

  #refuseInCoolDown(host, site) {
    const left = site.until - this.now();
    if (left > 0)
      throw new ToolError(
        `${host} blocked this browser a moment ago (HTTP ${site.status}), so it is not asked again for ${Math.ceil(left / 1000)} s. Tell the user, who can use Continue in Chrome.`,
        'blocked_by_site',
      );
  }

  /**
   * Before a navigation: refuses a site in its cool-down, and takes the next slot at least GAP_MS after the last one (navigations at the
   * same moment queue one after another), refusing again if a block came in while it waited.
   */
  async before(url) {
    const host = pacedHost(url);
    if (!host) return;
    const site = this.#site(host);
    this.#refuseInCoolDown(host, site);
    const start = Math.max(this.now(), site.last + GAP_MS);
    site.last = start;
    if (start > this.now()) {
      await this.wait(start - this.now());
      this.#refuseInCoolDown(host, site);
    }
  }

  /**
   * After a navigation to `url` that ended on `landed` (a redirect may change the site): a block starts (or doubles) the cool-down of both,
   * anything else ends it.
   */
  after(url, status, landed = url) {
    for (const host of new Set([pacedHost(url), pacedHost(landed)])) {
      const site = host ? this.sites.get(host) : null;
      if (!site) continue;
      if (BLOCK_STATUSES.has(Number(status))) {
        site.until = this.now() + site.cool;
        site.status = Number(status);
        site.cool = Math.min(site.cool * 2, MAX_COOL_MS);
      } else {
        site.until = 0;
        site.cool = COOL_MS;
      }
    }
  }
}

module.exports = { documentStatus, blockNote, pacedHost, SitePacing, GAP_MS, COOL_MS, MAX_COOL_MS };
