# mobile/vendor/orca

Pinned, renamed copies of Orca's phone presentation layer (design system, i18n setup, transcript, composer, renderers, settings, support pages, later the terminal engine). The plan is `design/phone-on-orca/plan.md`; the study behind it is `design/phone-on-orca/study.md`.

Rules (the import guard `tests/phoneVendorGuard.invariant.test.ts` enforces the first four):

1. Every file here has a row in `ORCA_FILES.md` with the Orca commit it came from, and every row names a file that exists.
2. A vendored file imports only other files in this folder, packages from `node_modules`, or the view-model and design system in `mobile/src/ui/`. Never `mobile/src/remote`, the runtime or the fold.
3. Nothing outside this folder imports `src/shared` or `@orca/`. A shared module Orca's code needs is copied in here, with its own row.
4. No Orca name, `orca://` link, `onorca.dev` host or Firebase file is kept: rename on copy.
5. Edit a vendored file only to rename or to cut an import. Behaviour changes go in a wrapper in `mobile/src/ui/`, so `git diff` against the Orca commit stays small.

Licence: `LICENSE-ORCA.md`. App screen data: `mobile/src/licences.json`.
