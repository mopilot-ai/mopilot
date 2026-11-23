// What the Licences screen lists, built from the copied-code data (mobile/src/licences.json): one row per holder, its notice behind it.

export type LicenceEntry = { id: string; name: string; holder: string; licence: string; source: string; notice: string };
export type LicenceRow = { id: string; title: string; detail: string; notice: string };

/** "Orca (Lovecast Inc.) · MIT": the name, who holds the copyright, then the licence; an entry with no notice text has no row (nothing to open). */
export function licenceRows(entries: readonly LicenceEntry[]): LicenceRow[] {
  return entries
    .filter((e) => e.notice.trim())
    .map((e) => ({ id: e.id, title: `${e.name} (${e.holder})`, detail: e.licence, notice: e.notice.trim() }));
}
