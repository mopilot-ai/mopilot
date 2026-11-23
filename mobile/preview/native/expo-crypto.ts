// Test-only random bytes for the web preview, from the browser.
export const getRandomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
