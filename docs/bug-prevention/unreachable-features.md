# Unreachable features

One of the [bug classes](README.md#bug-classes). A pull request adds its note about this class as a file of its own in
`notes/unreachable-features/` (one note per file), not below; the bullets below are the earlier notes.

A service method built and tested for a user-facing feature that nothing in the app calls: no tool, IPC handler,
button or startup step reaches it, so the feature exists only in its tests. MoMo's routines could not be created
because `routines.propose()` had no caller and setup's starter routines were saved and never read (#2285).

## Search for and ask

- Ask: *what calls this in production?* Follow it from the tool, IPC channel, button or startup step, not from the test.
- Ask: *does a setting or a saved value this adds have a reader?* A pref written by a window and read by nothing is the same gap.
- Ask: *can the user undo it?* A create with no remove, decline or pause leaves an item the user can't get rid of.
- Search: each public method of a new service, with `.name` across `electron/`, `src/` and `shared/` outside tests.

## Notes

- MoMo's services are held to it by `tests/momoEntryPoints.test.ts`: each public method of a class under `electron/momo/` is called by the app, or listed as internal with its reason or deferred with its issue. It matches by name, so a method whose name another module also uses (`remove`, `update`) still needs the sweep (#2285: `MomoRoutines.remove` had no caller either).
- A control whose prerequisite is a hidden setting is unreachable for most users. The mic button was always shown, but with no saved engine it dictated only when on-device recognition was ready; otherwise every press said "Choose an available dictation service in Voice settings" (speech PR1). With no saved engine, main now uses the first usable service (`speechEngine`, shared/speech.mjs), and the button is hidden while every service is blocked. Ask of every control: *with a fresh profile, what does the first press do, and when can it never work, is the control still shown?*
