// What a pairing code looks like and where an update comes from: a pasted text is only tried when it has the code's shape, and a phone that is too old is sent to its App Store page.

/** The App Store page of this app (the id is the one in mobile/eas.json, App Store Connect's, not a secret). */
export const APP_STORE_URL = 'https://apps.apple.com/app/id6836211752';

/** The text is JSON with the fields of a pairing code (a shape check only: the pairing itself checks every field and the proof). */
export function isPairingCode(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 4096 || trimmed[0] !== '{') return false;
  try {
    const q = JSON.parse(trimmed) as Record<string, unknown> | null;
    return (
      !!q &&
      typeof q === 'object' &&
      Number.isSafeInteger(q.v) &&
      typeof q.macId === 'string' &&
      typeof q.relay === 'string' &&
      typeof q.code === 'string' &&
      Number.isSafeInteger(q.exp)
    );
  } catch {
    return false;
  }
}
