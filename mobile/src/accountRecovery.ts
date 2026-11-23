// Recovery preserves account state unless credentials are explicitly irrecoverable; unknown failures must not suggest deleting paired computers.
export const REFRESH_SERVICE_UPDATE = "MoPilot's sign-in service needs an update. Your computers are still saved. Try again later.";
export const REFRESH_SIGN_IN = 'This sign-in cannot be restored. Sign in again to continue; you will need to pair your computers again.';

export const accountRequiresSignIn = (error: string | null) =>
  error === 'refresh interrupted; sign in again' || error === REFRESH_SIGN_IN || error === 'Account service returned HTTP 401';

export const accountRecoveryMessage = (error: string | null) => (accountRequiresSignIn(error) ? REFRESH_SIGN_IN : error);
