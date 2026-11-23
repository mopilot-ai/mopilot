// The day a time falls on in the window's zone, as MoMo's pages name it (YYYY-MM-DD): a module of its own with no imports, so a card drawn in a chat's turn (NudgeCard.tsx) needs nothing else of the Memory tab.

/** The day a time falls on here, as YYYY-MM-DD. */
export const day = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
