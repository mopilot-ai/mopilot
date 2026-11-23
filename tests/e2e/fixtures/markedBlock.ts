// One marked block in a text file a spec edits for the user (~/.ssh/config, authorized_keys): replaced in place on each run, so a machine that keeps its home between runs does not grow one block per run, and no line the spec did not write is touched.
const begin = (tag: string) => `# ${tag} begin`;
const end = (tag: string) => `# ${tag} end`;

/** `text` with the block `tag` put at its end, replacing the block `tag` that was there (any number of copies): lines outside the block stay as they are. */
export function withMarkedBlock(text: string, tag: string, body: string): string {
  const kept: string[] = [];
  let inside = false;
  for (const line of text.split('\n')) {
    if (line === begin(tag)) inside = true;
    else if (inside && line === end(tag)) inside = false;
    else if (!inside) kept.push(line);
  }
  // a begin without its end: the rest of the file is the user's, so a block we cannot close is not cut away
  if (inside) return `${text.replace(/\n*$/, '\n')}${begin(tag)}\n${body.replace(/\n*$/, '\n')}${end(tag)}\n`;
  const rest = kept.join('\n').replace(/\n*$/, '');
  return `${rest ? `${rest}\n\n` : ''}${begin(tag)}\n${body.replace(/\n*$/, '\n')}${end(tag)}\n`;
}
