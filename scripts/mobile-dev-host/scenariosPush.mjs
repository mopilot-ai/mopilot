// DEV ONLY: the bench scenarios that make the Mac push to the paired phone: chat titles in push, MoMo's opt-in push body, a real push, and the APNs body printed for xcrun simctl push.

/**
 * @param {object} o
 * @param {() => any} o.need the host's controls (throws while there are none)
 * @param {(arg: string | undefined, usage: string) => boolean} o.onOff reads "on" or "off"
 * @returns {Record<string, { usage: string, about: string, run: (args: string[]) => string | Promise<string> }>}
 */
export function pushScenarios({ need, onOff }) {
  return {
    titles: {
      usage: 'titles on|off',
      about: "the Mac's opt-in for chat titles in push: on seals each push's title for the phone, off sends the fixed text",
      run: ([arg]) => need().titles(onOff(arg, 'titles on|off')),
    },
    'push-body': {
      usage: 'push-body on|off',
      about:
        "the Mac's opt-in for MoMo's push body (A6): on, push-payload can print a body naming a routine, sealed for the phone; off, the fixed text",
      run: ([arg]) => need().pushBody(onOff(arg, 'push-body on|off')),
    },
    push: {
      usage: 'push [kind=needsYou] [chat=dev-seed-waiting] [channel=<id>] [card=<id>] [routine name]',
      about:
        "the Mac asks the relay to push to the paired phones: a real notification when the host has APNs or FCM keys (PUSH_MODE=direct), else the relay says why not; a routine name (momoNeedsYou, after push-body on) sends the sealed MoMo body too; channel= and card= (momoNeedsYou) name a channel's card by their handles, as the Mac's push for it does",
      run: ([kind = 'needsYou', chat = 'dev-seed-waiting', ...rest]) => {
        const named = (/** @type {string} */ key) => rest.find((w) => w.startsWith(`${key}=`))?.slice(key.length + 1);
        const name = rest.filter((w) => !w.startsWith('channel=') && !w.startsWith('card='));
        return need().push(kind, chat, name.length ? name.join(' ') : undefined, named('channel'), named('card'));
      },
    },
    'push-payload': {
      usage: 'push-payload [kind=needsYou] [chat=dev-seed-waiting] [card] [routine name]',
      about:
        "prints the APNs body the relay would send the paired phone (for xcrun simctl push); card names MoMo's card for momoNeedsYou, and a routine name (after push-body on) adds the sealed body",
      run: ([kind = 'needsYou', chat = 'dev-seed-waiting', card, ...name]) =>
        need().pushPayload(kind, chat, card, name.length ? name.join(' ') : undefined),
    },
  };
}
