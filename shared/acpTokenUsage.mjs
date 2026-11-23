// A basic (ACP) chat's token usage as the Codex-shaped report the context ring and the turn's tokens read: the context
// its usage_update says is used, and the session's tokens added up from each prompt's usage (zero until one reports),
// never the context size taken for a total. Main keeps one (electron/harness/items/acp.cjs).
import { addBreakdowns, fromAcpUsage, tokenBreakdown } from './contextSnapshot.mjs';

const ZERO = tokenBreakdown({ totalTokens: 0 });

export class AcpTokenUsage {
  /** By native session: the session's tokens so far, the prompts already counted, and the last context reading. */
  sessions = new Map();

  of(nid) {
    let s = this.sessions.get(nid);
    if (!s) this.sessions.set(nid, (s = { total: null, counted: new Set(), used: null, size: null }));
    return s;
  }

  /** The report for the context ring and the turn's tokens, or null before the session said how much context it uses. */
  report(nid) {
    const s = this.of(nid);
    if (s.used === null) return null;
    const last = { ...ZERO, inputTokens: s.used, totalTokens: s.used };
    return { total: s.total ?? ZERO, last, modelContextWindow: s.size };
  }

  /** A usage_update: the context now in use and the window's size. */
  contextUsed(nid, used, size) {
    const s = this.of(nid);
    s.used = used;
    s.size = typeof size === 'number' && size > 0 ? size : null;
    return this.report(nid);
  }

  /** A prompt's end with the usage it answered with: added to the session once per turn. */
  turnUsage(nid, turnId, usage) {
    const u = fromAcpUsage(usage);
    const s = this.of(nid);
    if (!u || (turnId && s.counted.has(turnId))) return null;
    if (turnId) s.counted.add(turnId);
    s.total = addBreakdowns(s.total, u);
    return this.report(nid);
  }

  /** The session closed: a new one starts its count again. */
  forget(nid) {
    this.sessions.delete(nid);
  }
}
