# Focused unit coverage

Changed measured behavior requires 100% lines, branches and functions. Keep the measured scope, test counts,
coverage result and limitations in the pull request. Do not raise exclusions or lint baselines to pass.

`npm run test:related -- --direct <files>` finds the direct unit-test dependencies. Run the chosen files through
`scripts/test-slots.mjs` with the root test command's Node options and `tests/support/register.ts`. It limits local
workers across checkouts. Install the root and mobile dependencies before checking shared code.

For a focused coverage run, use the existing `.c8rc.json` measurement policy and the selected unit files. Node's
coverage or c8 can provide feedback, but a subset pass is not evidence for unrelated behavior. Preserve final reports
in a distinct directory. CI must enforce the complete changed-code coverage contract before a behavioral change is
accepted. Report a missing CI gate as missing validation.

The source edition omits the hosted website, private analytics implementations and internal release/merge operators,
with their dependent tests. Its package manifest is derived from the shared manifest so dependencies and lockfiles
stay aligned. The official application's private CI validates that source before a snapshot is synchronized; that
result does not certify arbitrary later public-only changes.

Use focused unit tests for ordinary work. Broad regression suites, authenticated-service checks and app launch tests
require their applicable isolated workflow. Never launch or replace the user's installed MoPilot for validation.
