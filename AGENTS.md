# MoPilot development

Read this once before changing code. Search the module map (`npm run module-map`) or use targeted `rg`; load linked
guides only when the change needs them. [CONTRIBUTING](.github/CONTRIBUTING.md) is the human-facing version of the
same rules, and the [development guide](docs/development.md) covers setup.

## Scope and safety

- Write code, docs, commit messages and pull requests in English.
- Work on a branch and open a pull request against `main`; the pre-push hook refuses a push to `main`. Never
  force-push shared branches or skip hooks to get a change through.
- Never commit credentials, personal data, or code, strings or assets copied from other products.
- Never launch MoPilot, a test instance or an end-to-end suite on the desktop of the person you work for: a test
  window can take their focus, click in their apps and use their sign-ins. Use CI, a virtual machine or a spare user
  account, and say in the pull request where the check ran.

## Checks

Run these before you push, and only these while iterating. CI runs them on every pull request, with a format check
and the related tests' coverage, and runs the whole unit suite on `main`.

```bash
npm run test:related -- --direct <changed-files>   # the tests that reach the change
npm run test:coverage -- --changed --related       # run them; 100% of changed lines, branches and functions
npm run lint
npm run typecheck                                   # needs `npm --prefix mobile ci` once
npm run module-map -- --check
```

- Add a test that fails without the change and checks behavior at the layer that owns it, with expected values
  written out rather than computed by the code under test.
- Report test counts, the coverage scope and anything you could not check in the pull request. A skipped or partial
  run is not a pass. Never raise exclusions or lint baselines to pass.

## Making the change

- Before behavior edits, state the invariant, its owner and invalidators, the affected entry points and how you will
  validate it. The [change contract](docs/bug-prevention/change-contract.md) lists the failure scenarios to consider.
- For a bug, use the [fix-bug](.agents/skills/fix-bug/SKILL.md) skill: a failing test first, the root-cause class,
  siblings fixed together and a guard ([bug prevention](docs/bug-prevention/README.md)).
- Extend the existing helper or component before writing a parallel one. Name files after what they hold, never
  `utils` or `helpers`.
- Give each source file a one-line ownership header; `npm run module-map -- --check` checks it. Keep responsibilities
  cohesive ([code quality](docs/code-quality.md)). Avoid registries that many pull requests append to; discover by
  name, folder or marker.
- Interface work follows the [style guide](docs/style-guide.md) and [interface copy](docs/ui-copy.md): tokens from
  `src/styles/tokens.css`, the primitives in `src/components/ui/`, light and dark mode, every Chat font size.

## First-class areas

Every change considers each of these, or says why it does not apply:

1. **Every agent.** Codex, Claude Code and the admitted ACP agents share the outcome. Shared behavior lives in
   main-process services and typed adapters; native protocol and id handling stay inside the adapter. Show accurate
   degraded or blocked states; never drop work or claim unsupported success.
2. **Every platform.** macOS, Windows and Linux: guard platform code at runtime, build paths with `path.join`, and
   use the platform's shortcut labels.
3. **Remote Hosts and the phone.** A chat can run on another machine and be driven from a paired phone; do not assume
   a file, process or credential is local.

## Hosted services

The hosted website, account service, model gateway and product analytics are not part of this repository. Public
builds use no-op analytics (`docs/architecture/modularization.md`, `shared/observations.cjs`). A change that needs a
hosted endpoint should keep working when that endpoint is not configured.
