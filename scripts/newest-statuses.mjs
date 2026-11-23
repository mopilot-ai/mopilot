// One commit status context's newest result on many commits, read in one GraphQL request (main-e2e-scope, main-core-scope).
import { counts } from '../shared/statusTrust.ts';
/** @typedef {{ state: string, description?: string }} ContextStatus */

/**
 * The newest `context` status of each commit in `oids`: a lowercase state and its description, or null for a commit
 * with no such status, or whose newest one does not count (shared/statusTrust.ts; GraphQL serves only the newest per
 * context, so an older one that counts is not seen either: the commit reads as untested). Throws when the answer cannot
 * be read, so a caller never takes an unread commit for one with no status.
 * @param {{ gh: (args: string[]) => string, repo: string, oids: string[], context: string }} options
 * @returns {Map<string, ContextStatus | null>}
 */
export function newestStatuses({ gh, repo, oids, context }) {
  const [owner, name] = repo.split('/');
  // a commit with no status at all comes back null
  const fields = oids.map(
    (oid, i) =>
      `c${i}: object(oid: "${oid}") { ... on Commit { status { contexts { context state description creator { login __typename } } } } }`,
  );
  const answer = JSON.parse(
    gh([
      'api',
      'graphql',
      '-f',
      `query=query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields.join(' ')} } }`,
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
    ]),
  );
  const found = answer?.data?.repository;
  if (!found) throw new Error('no repository in the answer');
  /** @type {Map<string, ContextStatus | null>} */
  const states = new Map();
  oids.forEach((oid, i) => {
    const contexts = found[`c${i}`]?.status?.contexts;
    if (found[`c${i}`] === undefined || (contexts !== undefined && !Array.isArray(contexts)))
      throw new Error(`unreadable statuses on ${oid}`);
    const s = (contexts ?? []).find((/** @type {{ context: string }} */ c) => c.context === context);
    const state = String(s?.state ?? '').toLowerCase();
    states.set(oid, s && counts({ state, creator: s.creator }) ? { state, description: s.description ?? undefined } : null);
  });
  return states;
}
