// Terminal text without its ANSI escapes (colors, cursor moves, OSC titles and links), for reading a CLI's output.
// an OSC sequence (a title, a link) ends at its first BEL or ST, so a link's text between two of them stays
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g;

/** @param {unknown} s */
export const stripAnsi = (s) => String(s).replace(ANSI, '');
