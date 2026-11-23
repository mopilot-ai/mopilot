// Historical user images stay on their registered source Host, including after a move; exact chat/phone and current ownership fences guard every chunk before decoding for the phone.
const { readHostImage } = require('../host/imageTransfer.cjs');

/** `work` as it settles, or a refusal `code` once `ms` pass (a call that never answers must not hold a picture on its placeholder). */
function within(work, ms, code, message) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message), { code })), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** @param {{ connectMs?: number, readMs?: number }} [limits] deadlines for connecting an offline Host and for each chunk read; none means wait as long as the Host does (the phone's own pacing) */
async function phoneHostImage(live, chatId, ref, current, limits = {}) {
  current();
  const owner = live.hostOwnership?.get(chatId);
  if (!owner) return null;
  const source = ref.hostId ?? owner.hostId;
  if (!source || source === 'local') return null;
  const connection = () => (live.hostPhone?.imageHostFor ? live.hostPhone.imageHostFor(source) : live.imageHostFor?.(source));
  const host = connection();
  if (!host) return null;
  const check = () => {
    current();
    const latest = live.hostOwnership?.get(chatId);
    if (!latest || latest.hostId !== owner.hostId || latest.epoch !== owner.epoch || connection() !== host)
      throw Object.assign(new Error('This image source changed. Try again.'), { code: 'stale_epoch' });
  };
  if (host.state() !== 'online') {
    // a stopped machine's connect() settles only when it answers or the Host is dropped: with a deadline that is "away"
    await (limits.connectMs ? within(host.connect(), limits.connectMs, 'host_unreachable', 'The machine did not answer.') : host.connect());
    check();
  }
  const reading = limits.readMs
    ? {
        speaks: (feature) => host.speaks?.(feature),
        call: (method, params) =>
          within(host.call(method, params), limits.readMs, 'picture_timeout', 'The machine did not send the picture.'),
      }
    : host;
  const picture = await readHostImage({ host: reading, chatId, epoch: owner.epoch, imageId: ref.imageId, check });
  check();
  return picture ? { ...picture, check } : null;
}
module.exports = { phoneHostImage };
