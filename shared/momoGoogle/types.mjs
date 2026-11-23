// Shapes and ports of MoMo's Google connector: the sealed account record, why a source is disconnected, and what the Host injects (fetch, clock, token file).
/** Read-only scopes of the closed alpha, and the one optional send-only scope (D10). */
export const READ_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
];
export const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
/** What a working grant must still hold after every token answer: the two read scopes (the sign-in scopes `openid` and `email` are not asked of a refresh). */
export const READ_ACCESS = Object.freeze([
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
]);
