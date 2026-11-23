// Commit status fixtures as GitHub serves them: posted by the CI App (shared/statusTrust.ts) unless a fixture names its own creator.
import { STATUS_CREATORS } from '../../shared/statusTrust.ts';

/** The CI App's bot, the creator whose results count. */
export const CI = Object.freeze({ login: STATUS_CREATORS[0] });

/** Someone whose results do not count: an agent posting with its own token. */
export const AGENT = Object.freeze({ login: 'someone-else' });

/** `statuses` as the REST history serves them, each posted by the CI App unless it names its own `creator`. */
export const posted = <T extends object>(statuses: readonly T[]): (T & { creator: { login: string } })[] =>
  statuses.map((s) => ({ creator: CI, ...s }) as T & { creator: { login: string } });

/**
 * The same App as GraphQL serves it: an Actor named without the `[bot]` suffix REST adds, typed `Bot`. A GraphQL reader
 * must count it as the App (shared/statusTrust.ts creatorLogin) and a `User` of the same name as no one.
 */
export const CI_GRAPHQL = Object.freeze({ login: STATUS_CREATORS[0].replace(/\[bot\]$/, ''), __typename: 'Bot' });

/** A person whose login is the App's bare name: GraphQL serves it as the App's login without `[bot]`, typed `User`. */
export const NAMESAKE = Object.freeze({ login: CI_GRAPHQL.login, __typename: 'User' });

/** GraphQL `status { contexts }` entries, each posted by the CI App (as GraphQL names it) unless it names its own `creator`. */
export const contexts = <T extends object>(statuses: readonly T[]): (T & { creator: { login: string; __typename: string } })[] =>
  statuses.map((s) => ({ creator: CI_GRAPHQL, ...s }) as T & { creator: { login: string; __typename: string } });
