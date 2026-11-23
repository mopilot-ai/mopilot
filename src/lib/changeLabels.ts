// Shared file names and counts for the chat's changes pill and floating Changes card.
/** A file's name, on either platform. */
export function fileBaseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).at(-1) || trimmed;
}

/** "1 file changed" / "N files changed". */
export function filesChangedLabel(count: number): string {
  return `${count} ${count === 1 ? 'file' : 'files'} changed`;
}
