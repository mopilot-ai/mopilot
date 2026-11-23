// Shared review-page PR search, selection state and gh request helper.

import { create } from 'zustand';
import { useStore } from '../../../store/core';
import { errorText } from '../../../lib/ignored';
import { native } from '../../../lib/native';

export interface PR {
  number: number;
  title: string;
  url: string;
  repository: { nameWithOwner: string; name: string };
  updatedAt: string;
  isDraft?: boolean;
  state?: string;
  author?: { login: string };
}

export const useReview = create<{
  lists: Record<string, PR[] | null>;
  selected: PR | null;
  error: string | null;
  /** the team search alone failed: the other lists still show, and that section says why it is empty */
  teamError: string | null;
  query: string;
}>(() => ({ lists: { mine: null, review: null, team: null }, selected: null, error: null, teamError: null, query: '' }));

export const FIELDS = 'number,title,url,repository,updatedAt,isDraft,state,author';
export async function gh(args: string[]) {
  const r = await native.git.gh(useStore.getState().home, args);
  if (!r.ok) throw new Error(r.stderr.split('\n')[0] || 'gh failed');
  return r.stdout;
}
// the newest load of the lists: an older one answering late (a second Refresh, the page shown again) is dropped
let listsLoad = 0;
export async function loadLists() {
  const load = ++listsLoad;
  useReview.setState({ error: null, teamError: null, lists: { mine: null, review: null, team: null } });
  // gh reads everything after `--` as the query, so the flags come first. `review-requested:@me` also matches
  // requests made to a team the user is on, so the two review lists split it by `user-review-requested`; a
  // `team-review-requested` qualifier needs a team's name and rejects @me (gh 2.92 against github.com).
  const q = (extra: string[]) =>
    gh(['search', 'prs', '--state=open', '--json', FIELDS, '--limit', '20', ...extra]).then((o) => JSON.parse(o) as PR[]);
  try {
    const [mine, review, team] = await Promise.all([
      q(['--author=@me']),
      q(['--', 'user-review-requested:@me']),
      q(['--', 'review-requested:@me', '-user-review-requested:@me']).then(
        (list) => ({ list, error: null }),
        (e: unknown) => ({ list: [] as PR[], error: errorText(e) }),
      ),
    ]);
    if (load === listsLoad) useReview.setState({ lists: { mine, review, team: team.list }, teamError: team.error });
  } catch (e) {
    if (load === listsLoad) useReview.setState({ error: errorText(e), lists: { mine: [], review: [], team: [] } });
  }
}
