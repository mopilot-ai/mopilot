// Test-only system browser for the web preview: an authentication session opens nothing and is dismissed, so the sign-in that needs it says it did not finish.
export const openAuthSessionAsync = async (_url: string, _redirectUri: string) => ({ type: 'dismiss' as const });
