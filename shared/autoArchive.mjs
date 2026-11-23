// The choices for automatically archiving inactive chats (Settings → General, #1367), shared by Settings and main's sweep.

/** Days of inactivity Settings offers; anything else (null included) is Never. */
export const AUTO_ARCHIVE_DAYS = [3, 7, 14, 30, 90];

/**
 * The setting as a number of days, or null for Never.
 * @param {{ autoArchiveDays?: unknown } | null | undefined} prefs
 * @returns {number | null}
 */
export function autoArchiveDays(prefs) {
  const days = prefs?.autoArchiveDays;
  return typeof days === 'number' && AUTO_ARCHIVE_DAYS.includes(days) ? days : null;
}
