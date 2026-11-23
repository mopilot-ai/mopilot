// The notification each provider receives (and the Live Activity update, which is APNs only): an alert with the kind's fixed title and an empty body. The only other
// fields are the kind, the opaque chat handle the phone resolves locally (and, on MoMo's "needs you", the opaque handle of its card), and an optional sealed title blob and, on MoMo's "needs you", an optional sealed body blob (the user's own routine name, opt-in) the phone's
// notification extension decrypts on device (`mutable-content`); no plaintext chat content is ever built in here.

/** The longest sealed title blob the relay forwards (base64url of a short sealed string). */
export const MAX_SEALED = 2048;

/**
 * The ActivityKit update body: the activity's content state (counts, a kind, a start time, up to three rows) and the times the system acts on.
 * The state is decoded by the widget's Codable `ContentState`, so dates are plain unix seconds, not a Date encoding.
 * @param {NonNullable<import('./push.mjs').PushMessage['activity']>} a
 */
export function activityBody(a) {
  return {
    aps: {
      timestamp: a.timestamp,
      event: a.event,
      'content-state': a.state,
      'stale-date': a.staleAt,
      ...(a.event === 'end' && { 'dismissal-date': a.dismissAt }),
    },
  };
}

/**
 * @param {import('./push.mjs').PushMessage} m
 * @returns {object} the APNs JSON body
 */
export function apnsBody(m) {
  if (m.activity) return activityBody(m.activity);
  return {
    // the phone registers one notification category per kind (its lock-screen actions); an offline notice has none
    aps: {
      // a clearing has nothing to answer and makes no sound or light: it only replaces the waiting notification (same thread and collapse id)
      ...(m.kind !== 'machineOffline' && m.kind !== 'cleared' && { category: `mopilot.${m.kind}` }),
      alert: { title: m.title, body: '' },
      ...(m.kind === 'cleared' ? { 'interruption-level': 'passive' } : { sound: 'default' }),
      // an agent waits on the person: a Focus or a Scheduled Summary must not hold this back (iOS shows it as active when the app has no entitlement); "done", MoMo and offline notices keep the default level
      ...(m.kind === 'needsYou' && { 'interruption-level': 'time-sensitive' }),
      'thread-id': m.collapseId,
      ...((m.sealed || m.sealedBody) && { 'mutable-content': 1 }),
    },
    kind: m.kind,
    ref: m.ref,
    ...(m.card && { card: m.card }),
    ...(m.sealed && { st: m.sealed }),
    ...(m.sealedBody && { sb: m.sealedBody }),
  };
}

/**
 * @param {import('./push.mjs').PushMessage} m
 * @returns {object} the FCM HTTP v1 `message` (the caller adds nothing else)
 */
export function fcmMessage(m) {
  // Always data-only, high priority: a notification block makes Android show the fixed title itself and skip the app's own task, so the
  // phone could neither open a sealed title nor apply its lock-screen option. The app posts the notification; the fixed title (with
  // "(n)" and the count when merged) is its fallback. FCM data values are strings.
  return {
    token: m.token,
    android: { collapse_key: m.collapseId, priority: 'HIGH' },
    data: {
      kind: m.kind,
      ref: m.ref,
      title: m.title,
      count: String(m.count),
      ...(m.card && { card: m.card }),
      ...(m.sealed && { st: m.sealed }),
      ...(m.sealedBody && { sb: m.sealedBody }),
    },
  };
}
