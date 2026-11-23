// Types for the remote GitHub sign-in identity and its safe device page.
export const GIT_HOST: 'github.com';
export const GIT_LOGIN: 'git:github.com';
export const GIT_SIGNIN_FEATURE: 'gitSignin';
export function gitDevicePage(url: unknown): boolean;
export function gitLoginNeeds(method: string, params?: { harness?: unknown }): string[];
