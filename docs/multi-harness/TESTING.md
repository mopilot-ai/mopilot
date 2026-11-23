# Multi-harness testing

The repository's [agent policy](../../AGENTS.md) owns where tests and app checks may run. [Unit coverage](../unit-coverage.md) owns test commands, selection, thresholds and CI. This guide locates the fixtures used by the harnesses.

## Ordinary changes

Use [focused unit validation](../unit-coverage.md#checking-an-ordinary-change) and the [change contract](../bug-prevention/change-contract.md). Keep successful outcomes, failure handling, ownership and ordering in the real operation; fake its external boundaries.

The [test loader](../../tests/support/register.ts) resolves extensionless imports, compiles TSX and installs the test safeguards. Run tests through the repository runner so the loader, shared worker budget and process cleanup remain active.

For component tests, use the focused kits under `tests/support/`. The [dependency-testing guidance](../unit-coverage.md#writing-tests-for-components-and-modules-with-dependencies) explains how to isolate an operation without replacing its behavior.

## Fixtures

- [App fixture](../../tests/e2e/fixtures/app.ts): isolated app profiles, fake harness selection, launch and relaunch.
- [Fake Codex](../../tests/e2e/fixtures/fake-codex.mjs) and [fake Claude Code](../../tests/e2e/fixtures/fake-claude.mjs): deterministic CLI responses and transcripts.
- [Fake ACP agent](../../tests/fixtures/fake-acp-agent.mjs): admission, capability, mode, permission and prompt scenarios.
- [Async scenarios](../../tests/support/async-scenarios.ts): controlled promises for completion-order and retirement tests.
- `tests/support/ports/`: shared clock and native-port fakes.
- `tests/golden/`: recorded protocol fixtures.

Each fixture's source owns its options, keywords and environment variables. Read it instead of copying an older catalog into a new test.

## Real-environment verification

Follow [verifying the fix](../bug-prevention/README.md#verifying-the-fix) for a bug's original repro and [CI runners](../unit-coverage.md#ci-runners) for an authorized focused app check. Agents do not launch MoPilot on the user's Mac.

Broad E2E, CUJ and conformance suites remain subject to the [release policy](../unit-coverage.md#checking-a-release). Conformance uses real CLI accounts and can spend model tokens; [its own guide](../../tests/conformance/README.md) owns those procedures.

The native helper build scripts and [signing implementation](../../scripts/signing.mjs) own helper setup. Ad-hoc development helpers use a stable designated requirement to preserve macOS privacy grants across rebuilds; release signatures bind to the signing identity.

## Adding a journey test

Use the app fixture with fake boundaries, accessible locators and assertions on visible outcomes or requests sent to the fake. Keep new fake responses deterministic and document them in the fixture's header. Preserve isolated profiles and never include private conversations or screenshots in fixtures.

When a change alters a journey, update its spec in the same change. Use [E2E selection](../unit-coverage.md#e2e-specs) to identify affected specs; the runner and release rules determine where they execute.

## Pull requests

Use the current [pull request check](../unit-coverage.md#pull-request-check) and [merge procedure](../unit-coverage.md#merging). Record commands, measured coverage, failure-scenario evidence and the original-repro check in the PR.
