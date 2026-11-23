export const LOGIN_REFUSED_SIGNAL: 'oauth_org_not_allowed';
export function isLoginRefused(text: unknown): boolean;
export function claudeAuthFailed(m: { error?: unknown; message?: { content?: unknown } }): boolean;
