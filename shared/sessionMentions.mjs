// Chat mention tokens (`[title](session://id)`): writing and parsing them.

/** Stable chat references, shared by the editor and the main process. */
export function sessionToken(id, title) {
  return `[${title.replace(/[\\\[\]]/g, '\\$&').replace(/\s+/g, ' ')}](session://${encodeURIComponent(id).replace(/[()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())})`;
}

export function sessionMentions(text) {
  return [...text.matchAll(/\[((?:\\.|[^\]\\\n])*)\]\(session:\/\/([^\s)]+)\)/g)].flatMap((m) => {
    try {
      return [
        { token: m[0], title: m[1].replace(/\\(.)/g, '$1'), id: decodeURIComponent(m[2]), start: m.index, end: m.index + m[0].length },
      ];
    } catch {
      return [];
    }
  });
}
