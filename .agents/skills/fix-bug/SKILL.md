---
name: fix-bug
description: Fix a bug so its whole class stays fixed - reproduce it with a failing unit test, name its root-cause class, fix sibling instances in the same change, add a guard, and verify the original report before opening a pull request. Use for any bug report or bug found while working.
---

# Fix a bug class

Read [AGENTS.md](../../../AGENTS.md) and the matching [bug class](../../../docs/bug-prevention/README.md#bug-classes),
not every class page. Preserve unrelated work in the checkout.

## Reproduce

1. State the [change contract](../../../docs/bug-prevention/change-contract.md): the invariant, the code that owns
   it and what invalidates it, overlapping operations, and the affected entry points and agents. List the failure
   scenarios that apply, each with the test that covers it.
2. Write a unit test that fails before the fix, for the mechanism and not only the symptom. A mock that cannot
   reproduce the mechanism is not evidence. When the cause is in layout, packaging or wiring, record the failing
   reproducer at that layer and unit test the separable logic.
3. Explain the cause so that it accounts for everything observed, and name its class (or describe a new one).

## Sweep and guard

- Search for the same invariant across agent adapters, main-process and renderer copies, start, send, stop and
  retry paths, and shared state. Fix every sibling in this change, or say in the pull request why one is safe or
  belongs to a different invariant.
- Prefer one shared helper or a meaningful regression test. When the pattern can be matched mechanically, add or
  tighten a rule in `lint/rules/` with fixtures, or a whole-repository test named `tests/<name>.invariant.test.ts`.
  Never raise a baseline or add an ignore to pass.
- Name the step that should have caught the bug (the change contract, the review checklist, a check) and improve it
  when the gap is systemic.

## Validate

Run the related tests (`npm run test:related -- --direct <files>`) and coverage for the changed code
(`npm run test:coverage -- --changed --related`): 100% of changed lines, branches and functions. Run
`npm run lint`, `npm run typecheck` and `npm run module-map -- --check`.

Check the original report once in a real app before merging, in CI, a virtual machine or a spare user account, never
on the desktop someone is using. A fix to a test, lint rule or fixture says why it has no real-app check.

## Report

Describe in the pull request: **Root cause** (class and mechanism), **Sibling sweep** (what you searched, fixed or
left, and why), **Guard** (the rule, test or helper, or why there is none), **Verified the fix** (steps,
environment and result) and **Validation** (test counts, coverage scope and anything you could not check).
