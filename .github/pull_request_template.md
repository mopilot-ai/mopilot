## Summary

<!-- The problem, in plain words, and the behavior after this change. Link the issue: Fixes #123. -->

## Change contract

<!-- For behavior changes: the invariant, the code that owns it and what invalidates it, overlapping operations,
     and the affected entry points and agents (Codex, Claude Code, ACP). Omit for docs-only changes.
     See docs/bug-prevention/change-contract.md. -->

## Validation

<!-- Commands and results: related tests, their count, and the enforced coverage of the changed code
     (npm run test:coverage -- --changed --related). Platforms you checked. What you could not check. -->

## Screenshots

<!-- Before and after for interface changes, or "N/A" and why. -->

## Risk

<!-- What could break and for whom: saved data or settings, older paired phones or Hosts, other platforms, other
     agents, performance. How to back it out. -->

<!-- For a bug fix, also add Root cause, Sibling sweep, Guard and Verified the fix (docs/bug-prevention/README.md). -->

## Checklist

- [ ] The pull request is small and does one thing
- [ ] Changed behavior has focused unit tests with 100% changed line, branch and function coverage
- [ ] `npm run lint`, `npm run typecheck` and `npm run module-map -- --check` pass
- [ ] macOS, Windows, Linux, remote Host and phone impact considered (or N/A)
- [ ] No credentials, personal data, or code, strings or assets copied from other products
