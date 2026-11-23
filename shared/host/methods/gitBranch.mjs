// The wire methods that read a chat folder's branches and switch it to one on a Host (shared/host/gitBranch.mjs): an older Host has none, so an app without the feature is refused, never served half.
import { GIT_BRANCH_FEATURE, GIT_BRANCHES_METHOD, GIT_SWITCH_METHOD, gitBranchParsers } from '../gitBranch.mjs';

/** @param {{ bad: (message: string) => Error, pathOf: (v: unknown, what: string) => string }} kit */
export default ({ bad, pathOf }) => {
  const parse = gitBranchParsers(pathOf, bad);
  return {
    features: [GIT_BRANCH_FEATURE],
    methods: Object.fromEntries(
      [GIT_BRANCHES_METHOD, GIT_SWITCH_METHOD].map((m) => [m, { access: 'paired', requires: [GIT_BRANCH_FEATURE], parse: parse[m] }]),
    ),
  };
};
