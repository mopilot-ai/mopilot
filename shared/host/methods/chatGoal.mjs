// The wire declaration of `chat.goal` (feature `goalControls`): the owner's epoch and the key make a resend safe, as for every chat write.
import { GOAL_FEATURE, goalParsers } from '../chatGoal.mjs';

export default (/** @type {{ effect: (p: any) => object, bad: (message: string) => Error }} */ kit) => {
  const parsers = goalParsers(kit);
  return {
    features: [GOAL_FEATURE],
    methods: { 'chat.goal': { access: 'paired', requires: ['epoch', 'dedupe', 'family', GOAL_FEATURE], parse: parsers['chat.goal'] } },
  };
};
