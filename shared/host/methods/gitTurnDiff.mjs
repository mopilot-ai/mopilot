// The wire method that reads what one turn changed in a chat's folder on a Host (shared/host/gitTurnDiff.mjs): an older Host has none, so an app without the feature is refused, never served half.
import { GIT_TURN_DIFF_FEATURE, GIT_TURN_DIFF_METHOD, gitTurnDiffParsers } from '../gitTurnDiff.mjs';

/** @param {{ bad: (message: string) => Error, pathOf: (v: unknown, what: string) => string }} kit */
export default ({ bad, pathOf }) => ({
  features: [GIT_TURN_DIFF_FEATURE],
  methods: {
    [GIT_TURN_DIFF_METHOD]: {
      access: 'paired',
      requires: [GIT_TURN_DIFF_FEATURE],
      parse: gitTurnDiffParsers(pathOf, bad)[GIT_TURN_DIFF_METHOD],
    },
  },
});
