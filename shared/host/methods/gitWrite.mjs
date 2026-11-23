// The wire methods that commit and discard changes in a chat's folder on a Host (shared/host/gitWrite.mjs): an older Host has none, so an app without the feature is refused, never served half.
import { GIT_COMMIT_METHOD, GIT_DISCARD_METHOD, GIT_WRITE_FEATURE, gitWriteParsers } from '../gitWrite.mjs';

/** @param {{ bad: (message: string) => Error, pathOf: (v: unknown, what: string) => string }} kit */
export default ({ bad, pathOf }) => {
  const parse = gitWriteParsers(pathOf, bad);
  return {
    features: [GIT_WRITE_FEATURE],
    methods: Object.fromEntries(
      [GIT_COMMIT_METHOD, GIT_DISCARD_METHOD].map((m) => [m, { access: 'paired', requires: [GIT_WRITE_FEATURE], parse: parse[m] }]),
    ),
  };
};
