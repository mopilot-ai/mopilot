// The build profile: a development build keeps the dev client's local-network access, a preview or production build is what the stores receive and must carry none of it.
const PROFILES = ['development', 'preview', 'production'];

/**
 * MOPILOT_BUILD_PROFILE names the profile (eas.json sets it). Unset, a dev host, a free-account device build or the dev-client flag mean
 * development, and anything else is a store build, so a forgotten variable can only remove the dev-only access, never ship it.
 * @param {Record<string, string | undefined>} env
 * @param {boolean} hasDevHost whether MOPILOT_DEV_HOST named a valid dev host
 * @returns {{ name: 'development' | 'preview' | 'production', development: boolean }}
 */
function resolveProfile(env, hasDevHost) {
  const named = (env.MOPILOT_BUILD_PROFILE ?? '').trim();
  if (named && !PROFILES.includes(named)) throw new Error(`MOPILOT_BUILD_PROFILE must be one of ${PROFILES.join(', ')}, got "${named}"`);
  const devSignals = [
    hasDevHost && 'MOPILOT_DEV_HOST',
    (env.MOPILOT_DEVICE_BUILD ?? '').trim() === '1' && 'MOPILOT_DEVICE_BUILD=1',
    (env.MOPILOT_DEV_CLIENT ?? '').trim() === '1' && 'MOPILOT_DEV_CLIENT=1',
  ].filter(Boolean);
  if (named === 'preview' || named === 'production') {
    if (devSignals.length) throw new Error(`a ${named} build cannot use ${devSignals.join(' or ')}: they only exist for development builds`);
    return { name: named, development: false };
  }
  const name = named === 'development' || devSignals.length ? 'development' : 'production';
  return { name, development: name === 'development' };
}

module.exports = { PROFILES, resolveProfile };
