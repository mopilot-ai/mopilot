// claude.ai artifact and design links (what Claude Code's Artifact and ClaudeDesign tools publish), recognized strictly by host and path; pure.
import { proseLinks } from './proseLinks.mjs';

/** Claude Code's built-in tools that work with claude.ai artifacts and Claude Design projects. */
export const DESIGN_TOOLS = new Set(['Artifact', 'ArtifactComments', 'ArtifactData', 'ClaudeDesign', 'DesignSync']);

// claude.ai/code/artifact/<uuid>, claude.ai/artifact/<short id> and claude.ai/design/p/<project id>
const PATHS = [
  // a uuid is one id in either case, so its link is lowercased
  { re: /^\/code\/artifact\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i, kind: 'artifact', fold: true },
  { re: /^\/artifact\/([A-Za-z0-9_-]{4,64})\/?$/, kind: 'artifact' },
  { re: /^\/design\/p\/([A-Za-z0-9_-]{4,64})\/?$/, kind: 'design' },
];

/**
 * What a link is, when it is a claude.ai artifact or design page: its kind, the link without its query or fragment
 * (one page, however it was linked), and its id. Only https on claude.ai itself, with no credentials or port, counts:
 * `claude.ai.example.com` or `https://claude.ai@example.com/…` is someone else's page.
 */
export function classifyClaudeUrl(url) {
  if (typeof url !== 'string') return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'claude.ai' || u.port || u.username || u.password) return null;
  for (const p of PATHS) {
    const m = p.re.exec(u.pathname);
    if (!m) continue;
    const path = u.pathname.replace(/\/$/, '');
    return p.fold
      ? { kind: p.kind, id: m[1].toLowerCase(), canonical: `https://claude.ai${path.toLowerCase()}` }
      : { kind: p.kind, id: m[1], canonical: `https://claude.ai${path}` };
  }
  return null;
}

/** The first claude.ai artifact or design link in a text, with trailing punctuation dropped; null when none. */
export function findClaudeUrl(text) {
  if (typeof text !== 'string') return null;
  // a link as tool results print it: up to whitespace, a quote, a backtick or a closing bracket
  for (const url of proseLinks(text)) {
    const found = classifyClaudeUrl(url);
    if (found) return { url, ...found };
  }
  return null;
}
