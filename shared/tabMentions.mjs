// Browser tab references in a prompt (BU-09). The composer inserts a token for a tab the user picked
// from the @ menu: one of the chat's in-app browser tabs, or a tab in the user's Chrome that an agent's
// browser tools reported. The token stays in the draft and the queued message; each harness adapter
// serializes it on send in the form its browser tooling understands (TabMentionStyle):
//   'codex-browser-plugin': a Chrome tab the Codex Browser plugin reported becomes the plugin's own
//     tab mention link (docs/tab-claiming-chrome.md: plugin://browser@openai-bundled?mention=tab-v1&
//     source=extension&browserId=…&tabId=…&title=…&url=…); a Chrome tab without a browser id is text.
//   'text': plain words with the tab's title and URL (Claude Code, ACP harnesses).
// An in-app tab is the same in every style: its title, URL and the tabId the browser_* tools take.

import { wellFormedUriText } from './uriText.mjs';

const SCHEME = 'mopilot-tab://';
const PLUGIN = 'plugin://browser@openai-bundled';

/** A query value: encodeURIComponent, with the parentheses that would end a markdown link encoded too. */
const enc = (s) => encodeURIComponent(s).replace(/[()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
/** A title as markdown link text: brackets and backslashes escaped, whitespace on one line. */
const linkText = (t) => t.replace(/[\\[\]]/g, '\\$&').replace(/\s+/g, ' ');

/**
 * The composer token for a tab: `[Title](mopilot-tab://chrome?tabId=…&url=…&browserId=…)`.
 * @param {{ where: 'app' | 'chrome', title: string, url: string, tabId?: string | null, browserId?: string | null }} tab
 */
export function tabToken(tab) {
  const query = [
    ['tabId', tab.tabId],
    ['url', tab.url],
    ['browserId', tab.browserId],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${enc(String(v))}`)
    .join('&');
  return `[${linkText(tab.title || tab.url)}](${SCHEME}${tab.where}?${query})`;
}

/** Our token, or a tab mention link the Codex Browser plugin understands (a sent Codex message reads back with it). */
const TOKEN = /\[((?:\\.|[^\]\\\n])*)\]\((?:mopilot-tab:\/\/(app|chrome)|plugin:\/\/([\w-]+@[\w.-]+))\?([^\s)]*)\)/g;

function params(query) {
  const out = {};
  for (const pair of query.split('&')) {
    const at = pair.indexOf('=');
    if (at > 0) out[pair.slice(0, at)] = decodeURIComponent(pair.slice(at + 1));
  }
  return out;
}

/**
 * The tab references in a text, in order. `native` marks a Codex plugin link (already in the
 * harness's form); our own tokens are what adapters serialize.
 */
export function tabMentions(text) {
  return [...String(text).matchAll(TOKEN)].flatMap((m) => {
    try {
      const p = params(m[4]);
      // a plugin:// link is a tab mention only when it says so; only the bundled plugin's own
      // (source-less) mention names an in-app tab, every other one a tab in an external browser
      if (m[3] && p.mention !== 'tab-v1') return [];
      const where = m[2] ?? (m[3] === 'browser@openai-bundled' && p.source !== 'extension' ? 'app' : 'chrome');
      return [
        {
          token: m[0],
          title: m[1].replace(/\\(.)/g, '$1'),
          where,
          url: p.url ?? '',
          tabId: p.tabId ?? null,
          browserId: p.browserId ?? null,
          native: !!m[3],
          start: m.index,
          end: m.index + m[0].length,
        },
      ];
    } catch {
      return [];
    }
  });
}

/** How one tab reads to a harness. */
function serialize(m, style) {
  const url = m.url ? ` <${m.url}>` : '';
  if (m.where === 'app')
    return `the built-in browser tab “${m.title}”${url}${m.tabId ? ` (tabId "${m.tabId}" for the browser_* tools)` : ''}`;
  if (style === 'codex-browser-plugin' && m.browserId && m.tabId)
    return `[${linkText(m.title)}](${PLUGIN}?mention=tab-v1&source=extension&browserId=${enc(m.browserId)}&tabId=${enc(m.tabId)}&title=${enc(wellFormedUriText(m.title))}&url=${enc(m.url)})`;
  return `the open tab “${m.title}”${url} in my Chrome`;
}

/**
 * The prompt with each tab token in a harness's form (see the top of this file).
 * @param {string} prompt
 * @param {'codex-browser-plugin' | 'text'} style
 */
export function withTabMentions(prompt, style) {
  let out = '';
  let at = 0;
  for (const m of tabMentions(prompt)) {
    if (m.native) continue;
    out += prompt.slice(at, m.start) + serialize(m, style);
    at = m.end;
  }
  return at ? out + prompt.slice(at) : prompt;
}
