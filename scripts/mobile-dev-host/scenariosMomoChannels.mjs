// DEV ONLY: the `momo-channels` bench scenario (MoMo's channels and groups, A2), kept in a file of its own because scenarios.mjs sits at its size limit; the host adds it to the scenarios createScenarios makes (host.mjs) instead of editing that list.

/**
 * `momo-channels push [channel]` raises a card in the channel (the first one, or the named) and sends a needs-you push for it, so a tap on it can be checked on a device.
 * `momo-channels [on|off|seed]`: the Mac says channels are on (on, the default: the phone's MoMo header opens the picker and a channel is made by name), or off or an older Mac (off: the
 * methods are not in the hello and the phone draws nothing of channels), or on with a few channels and a group already there (seed: Trip, Kitchen and Garden, groups Home and Work).
 * @param {{ channels?: boolean }} bench
 * @param {{ seed: () => Promise<{ groups: number, channels: number }>, raiseCard: (name?: string) => Promise<{ name: string, id: string, chatId: string, cardId: string }> }} fake the fake Mac's channels (fakeMomoChannels.mjs)
 * @param {(area: 'channels') => void} changed tells the phones the list changed, so the open page reads it again
 * @param {(name: string, args: string[]) => unknown} [run] the host's other scenarios (`push` sends the needs-you push)
 */
export function momoChannelsScenario(bench, fake, changed, run = () => undefined) {
  return {
    usage: 'momo-channels [on|off|seed|push [channel]]',
    about:
      'the Mac has MoMo channels on (on, the default), off or an older Mac (off: the phone draws nothing of them), or on with Trip, Kitchen and Garden in the groups Home and Work (seed); push [channel] raises a card in a channel and sends a needs-you push for it',
    run: async (/** @type {string[]} */ [arg = 'on', ...rest]) => {
      const word = arg.toLowerCase();
      if (word === 'push') {
        const card = await fake.raiseCard(rest.join(' ') || undefined);
        // a MoMo needs-you push: ref is the channel's handle and card the card's, as the Mac sends them (a tap opens the channel on that card)
        return `a card waits in #${card.name}; ${await run('push', ['momoNeedsYou', card.chatId, `channel=${card.id}`, `card=${card.cardId}`])}`;
      }
      if (word !== 'on' && word !== 'off' && word !== 'seed') throw new Error('Usage: momo-channels [on|off|seed|push [channel]]');
      bench.channels = word !== 'off';
      if (word === 'seed') {
        const made = await fake.seed();
        return `channels are on with ${made.channels} channels in ${made.groups} groups: the open MoMo page reads them at once`;
      }
      changed('channels');
      return `the Mac's MoMo channels are ${word}: the open MoMo page reads it at once`;
    },
  };
}

/**
 * The scenarios with `momo-channels` among them.
 * @template {{ list: () => { usage: string, about: string }[], run: (name: string, args?: string[]) => unknown }} S
 * @param {S} scenarios
 * @param {{ channels?: boolean }} bench
 * @param {Parameters<typeof momoChannelsScenario>[1]} fake
 * @param {(area: 'channels') => void} changed
 */
export function withMomoChannels(scenarios, bench, fake, changed) {
  const mine = momoChannelsScenario(bench, fake, changed, (name, args) => scenarios.run(name, args));
  return {
    ...scenarios,
    list: () => [...scenarios.list(), { usage: mine.usage, about: mine.about }],
    run: (/** @type {string} */ name, /** @type {string[]} */ args = []) =>
      name === 'momo-channels' ? mine.run(args) : scenarios.run(name, args),
  };
}
