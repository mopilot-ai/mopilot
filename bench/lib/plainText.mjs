// Model and app text as the graders' patterns spell it: typographic apostrophes and quotes as plain ones, so "can’t" reads as "can't" (#1384).

/** `s` with curly and other typographic apostrophes and double quotes made plain. @param {unknown} s */
export const plainQuotes = (s) =>
  String(s ?? '')
    .replace(/[‘’‛ʼ′]/g, "'")
    .replace(/[“”‟″]/g, '"');
