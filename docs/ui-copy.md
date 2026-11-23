# UI copy

Cards, notices and settings rows read like Claude Desktop's and the Codex app's: short and plain.

- A card asks one question ("Allow Claude Code to use example.com in your Chrome?"). Add at most one short line,
  and only when it changes the decision: a risky site's class, an action that can't be undone.
- A notice says what happened and the next step in one line. Buttons carry the actions; the text doesn't repeat them.
- Detail that rarely matters (where a saved grant lives, what each access level covers) goes in a tooltip.
- No reassurance paragraphs ("still asks before…", "your data stays…"). Drop what the buttons or the UI already say.

## Guard

`tests/copyLength.test.ts` (a scoped invariant selected by its guard or dependency edges) reads every prose string on the
approval cards, the computer-use strips, browser, sign-in and download notices, refusals and the Browser and Computer use settings
(`scripts/copy-length.mjs` finds string and template literals and JSX text, counting each `{…}` as 8 characters)
and fails on one longer than the cap: 60 characters on a card (Claude Desktop's longest card question,
"Allow Claude to use {domain} in Chrome on your computer?"), 72 on a notice, strip or settings row. Strings the model reads rather than the user (hand-off instructions,
tool results) are listed in its `LONGER` table with why; an entry that no longer matches fails too, so the
list only shrinks. Every `src/components` file named `*Notice*`, `*Strip*`, `*Card*`, `*Banner*` or `*Hint*` is
scanned by name, so a new one is covered when it's created; add a new approval card file to its `CARDS`, and any other
notice or settings file to its `NOTICES`.
