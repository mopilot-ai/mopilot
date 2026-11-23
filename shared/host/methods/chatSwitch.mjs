// The wire declaration of `chat.switch` (feature `switch`): the owner's epoch and the key make a resend safe, as for every chat write.
import { SWITCH_FEATURE, switchParsers } from '../chatSwitch.mjs';

export default (
  /** @type {{ effect: (p: any) => object, bad: (message: string) => Error, pathOf: unknown, matchOf: unknown, scoped: unknown }} */ kit,
) => {
  const parsers = switchParsers({
    effect: kit.effect,
    // the same harness ids a start takes
    harnessOf: (v) => {
      const harness = String(v ?? '');
      if (!/^(codex|claude|acp:[\w.-]{1,64})$/.test(harness)) throw kit.bad('Pick an agent to move this chat to.');
      return harness;
    },
    bad: kit.bad,
  });
  return {
    features: [SWITCH_FEATURE],
    methods: {
      'chat.switch': { access: 'paired', requires: ['epoch', 'dedupe', 'family', SWITCH_FEATURE], parse: parsers['chat.switch'] },
    },
  };
};
