// What the Host registry keeps of a cloud machine (kind `cloud`): which provider made it, its id there, where, what size, which network level, and how long it may idle and run (what its Host is told). Nothing here is secret; the provider key is in cloudKeys.cjs.
/** How long a cloud machine idles before it stops, when nothing else was chosen (plan C2). */
const DEFAULT_IDLE_MINUTES = 30;
const text = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && /^[\x21-\x7e]+$/.test(v);

/**
 * The cloud part of a record, or null when it is not a whole one.
 * @param {any} raw
 * @returns {{ provider: string, id: string, region: string, size: string, network: 'full' | 'limited', idleMinutes: number, hoursPerDay: number | null } | null}
 */
function cloudOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!text(raw.provider, 32) || !text(raw.id, 256)) return null;
  return {
    provider: raw.provider,
    id: raw.id,
    region: text(raw.region, 64) ? raw.region : '',
    size: text(raw.size, 128) ? raw.size : '',
    network: raw.network === 'limited' ? 'limited' : 'full',
    idleMinutes:
      Number.isSafeInteger(raw.idleMinutes) && raw.idleMinutes >= 1 && raw.idleMinutes <= 10080 ? raw.idleMinutes : DEFAULT_IDLE_MINUTES,
    hoursPerDay: Number.isSafeInteger(raw.hoursPerDay) && raw.hoursPerDay >= 1 && raw.hoursPerDay <= 24 ? raw.hoursPerDay : null,
  };
}

module.exports = { cloudOf, DEFAULT_IDLE_MINUTES };
