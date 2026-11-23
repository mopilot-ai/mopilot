// How a client learns that MoMo's home is offered: ONE name, `momoHome`, in the two hellos a client reads, and one function that reads either (home lane, #5474).
//
//  - A Host's `host.hello` carries it in `features` (an array of names): `momoHome` is there only while this Host is the running home and the client may see MoMo.
//  - The Mac's `machine.hello` (the phone's channel) carries it in `capabilities.momoHome: true`, and leaves the field absent (never false) unless MoMo is allowed for the
//    account and the `momo.home` flag is on; then `momo.home.view`, `momo.home.intent` and the event `momo.home.changed` exist, and not before.
//  - A phone connected directly to a Host reads the Host's `features` the same way: the answer is the same boolean.
// A client asks `homeOffered(hello)` with whichever hello it has; it never inspects the two shapes itself.

/** The one name. */
export const HOME_FEATURE = 'momoHome';

/** @param {{ capabilities?: { momoHome?: unknown } | null, features?: unknown } | null | undefined} hello a `machine.hello` answer or a `host.hello` answer */
export function homeOffered(hello) {
  if (hello?.capabilities?.momoHome === true) return true;
  return Array.isArray(hello?.features) && hello.features.includes(HOME_FEATURE);
}
