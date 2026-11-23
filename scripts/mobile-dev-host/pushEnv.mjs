// DEV ONLY: the dev host's relay sends real pushes when the operator's push settings are in the environment (PUSH_MODE, APNS_*, APNS2_*, FCM_*, PUSH_PROXY_*); nothing is read from the repository and the keys are never printed.
import { apnsSetsOf } from '../../relay/src/config.mjs';

/** The settings the relay's own config reads for push, and only those. */
const PUSH_NAMES = /^(?:PUSH_MODE|PUSH_PROXY_URL|PUSH_PROXY_TOKEN|APNS2?_[A-Z_]+|FCM_[A-Z_]+)$/;

/** @param {Record<string, string | undefined>} env */
export function pushEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => PUSH_NAMES.test(name) && value));
}

/**
 * One line saying how the relay will push, with no key, token or file path in it.
 * @param {{ mode: string, proxyUrl?: string, proxyToken?: string, apns?: import('../../relay/src/config.mjs').ApnsKeys | null, apnsSets?: import('../../relay/src/config.mjs').ApnsKeys[], fcm?: { project_id: string } | null }} push the relay config's `push`
 */
export function describePush(push) {
  if (push.mode === 'none') return 'push is off (PUSH_MODE=none)';
  if (push.mode === 'dryrun') return 'push: dry run (what would be sent is logged, nothing is sent)';
  if (push.mode === 'proxy') return `push: via the proxy at ${push.proxyUrl}`;
  const parts = [];
  for (const apns of apnsSetsOf(push))
    parts.push(`APNs ${apns.sandbox ? 'development (sandbox)' : 'production'} for ${apns.topic}, team ${apns.teamId}, key ${apns.keyId}`);
  if (push.fcm) parts.push(`FCM project ${push.fcm.project_id}`);
  return `push: direct, ${parts.join(', ')}`;
}
