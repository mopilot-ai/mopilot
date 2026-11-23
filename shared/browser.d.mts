export function browserUrl(raw: string): string | null;
export function isWebUrl(value: unknown): value is string;
export function isIdentityProvider(value: string): boolean;
export function restartUrl(values: string[]): string | null;
export function isSecretParam(name: string, value?: string, oauth?: boolean): boolean;
export function mayNameSecret(name: string): boolean;
export const CHROME_APPROVAL: string;
