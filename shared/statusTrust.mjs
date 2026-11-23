// Owns the runtime CI identity policy for scripts and packaged main-process repair coordination.
/** @type {readonly string[]} */
export const STATUS_CREATORS = Object.freeze(['mopilot-ci[bot]']);
/** @type {readonly string[]} */
export const RESERVATIONS = Object.freeze(['dogfood-dispatch']);
/** @typedef {{context?: string, state: string, creator?: {login?: string | null, __typename?: string | null} | null}} Posted */
/** @param {Posted['creator']} creator */
export const creatorLogin = (creator) => {
  const login = creator?.login ?? '';
  return creator?.__typename === 'Bot' && login && !login.endsWith('[bot]') ? `${login}[bot]` : login;
};
/** @param {Posted} status @param {readonly string[]} [creators] */
export const counts = (status, creators = STATUS_CREATORS) =>
  status.state.toLowerCase() === 'pending' ||
  RESERVATIONS.includes(status.context ?? '') ||
  creators.includes(creatorLogin(status.creator));
/** @template {Posted} T @param {T[]} statuses @param {readonly string[]} [creators] @returns {T[]} */
export const trusted = (statuses, creators = STATUS_CREATORS) => statuses.filter((s) => counts(s, creators));
