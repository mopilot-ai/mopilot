// Git path output preserves filename whitespace and removes only the terminating LF.
export const parseGitPathLine = (out) => String(out || '').replace(/\n$/, '');
