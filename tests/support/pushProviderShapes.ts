// What APNs and FCM really answer, as the fake providers in the push tests send it: status, headers and body as documented by Apple (HTTP/2 APNs provider API) and Google (FCM HTTP v1 and its OAuth token endpoint).

export type Answer = { status: number; headers?: Record<string, string>; body?: object };

/** APNs: a 200 has an empty body; an error has {"reason": ...} (and a 410 a "timestamp" in milliseconds). */
export const apns = {
  ok: (): Answer => ({ status: 200, headers: { 'apns-id': 'E9F3D0A4-2C56-4F2C-9E3B-5BDB1D2B6A70' } }),
  badDeviceToken: (): Answer => ({ status: 400, body: { reason: 'BadDeviceToken' } }),
  deviceTokenNotForTopic: (): Answer => ({ status: 400, body: { reason: 'DeviceTokenNotForTopic' } }),
  badTopic: (): Answer => ({ status: 400, body: { reason: 'BadTopic' } }),
  unregistered: (): Answer => ({ status: 410, body: { reason: 'Unregistered', timestamp: 1_700_000_000_000 } }),
  expiredProviderToken: (): Answer => ({ status: 403, body: { reason: 'ExpiredProviderToken' } }),
  invalidProviderToken: (): Answer => ({ status: 403, body: { reason: 'InvalidProviderToken' } }),
  payloadTooLarge: (): Answer => ({ status: 413, body: { reason: 'PayloadTooLarge' } }),
  tooManyRequests: (retryAfter?: string): Answer => ({
    status: 429,
    ...(retryAfter && { headers: { 'retry-after': retryAfter } }),
    body: { reason: 'TooManyRequests' },
  }),
  internalServerError: (): Answer => ({ status: 500, body: { reason: 'InternalServerError' } }),
  serviceUnavailable: (): Answer => ({ status: 503, body: { reason: 'ServiceUnavailable' } }),
};

const fcmError = (status: number, code: string, message: string, details: object[] = []): Answer => ({
  status,
  body: { error: { code: status, message, status: code, details } },
});
const fcmDetail = (errorCode: string) => ({ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode });

/** FCM HTTP v1: a 200 is {"name": "projects/<id>/messages/<id>"}; an error is {"error": {code, message, status, details}}. */
export const fcm = {
  ok: (): Answer => ({ status: 200, body: { name: 'projects/proj-1/messages/0:1700000000000000%31bd1c9631bd1c96' } }),
  unregistered: (): Answer => fcmError(404, 'NOT_FOUND', 'Requested entity was not found.', [fcmDetail('UNREGISTERED')]),
  notFoundPlain: (): Answer => fcmError(404, 'NOT_FOUND', 'Requested entity was not found.'),
  invalidToken: (): Answer =>
    fcmError(400, 'INVALID_ARGUMENT', 'The registration token is not a valid FCM registration token', [
      {
        '@type': 'type.googleapis.com/google.rpc.BadRequest',
        fieldViolations: [{ field: 'message.token', description: 'The registration token is not a valid FCM registration token' }],
      },
    ]),
  invalidPayload: (): Answer =>
    fcmError(400, 'INVALID_ARGUMENT', 'Invalid value at message.data', [
      { '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'message.data', description: 'Invalid value' }] },
    ]),
  senderIdMismatch: (): Answer => fcmError(403, 'PERMISSION_DENIED', 'SenderId mismatch', [fcmDetail('SENDER_ID_MISMATCH')]),
  permissionDenied: (): Answer =>
    fcmError(403, 'PERMISSION_DENIED', 'Firebase Cloud Messaging API has not been used in project 123 before or it is disabled.'),
  unauthenticated: (): Answer =>
    fcmError(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.', [fcmDetail('THIRD_PARTY_AUTH_ERROR')]),
  quotaExceeded: (retryAfter = '30'): Answer => ({
    ...fcmError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded for quota metric', [fcmDetail('QUOTA_EXCEEDED')]),
    headers: { 'retry-after': retryAfter },
  }),
  internal: (): Answer => fcmError(500, 'INTERNAL', 'Internal error encountered.', [fcmDetail('INTERNAL')]),
  unavailable: (retryAfter = '5'): Answer => ({
    ...fcmError(503, 'UNAVAILABLE', 'The service is currently unavailable.', [fcmDetail('UNAVAILABLE')]),
    headers: { 'retry-after': retryAfter },
  }),
  token: (): Answer => ({ status: 200, body: { access_token: 'ya29.fake', expires_in: 3599, token_type: 'Bearer' } }),
  invalidGrant: (): Answer => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } }),
};

/** A fetch that answers from a script; a hanging one honours its abort signal the way the real one does. */
export function scriptedFetch(plan: (url: string, n: number) => Answer | 'hang' | Error) {
  const calls: { url: string; init: any }[] = [];
  const f = async (url: string, init: any) => {
    calls.push({ url, init });
    const r = plan(url, calls.length);
    if (r instanceof Error) throw r;
    if (r === 'hang')
      return new Promise((_, reject) => {
        const abort = () => reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener('abort', abort);
      });
    return {
      ok: r.status < 300,
      status: r.status,
      headers: new Headers(r.headers),
      json: async () => r.body ?? Promise.reject(new Error('no body')),
    };
  };
  return { calls, f: f as any };
}
