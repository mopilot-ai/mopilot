# Contributing to MoPilot

Thanks for helping. This guide covers the path from a fresh clone to a merged pull request. To report a security
problem, follow [SECURITY.md](SECURITY.md) instead of opening an issue. Everyone taking part follows the
[code of conduct](CODE_OF_CONDUCT.md).

## Before you start

- Search the existing issues. For a large change, open an issue first so the approach can be agreed before you write
  the code.
- Read [AGENTS.md](../AGENTS.md). It holds the repository's working rules for people and coding agents alike.
- Write code, docs, commit messages and pull requests in English.

## Set up

Follow the [development guide](../docs/development.md): the toolchains for each OS, installing dependencies,
running a development instance and packaging. In short, with Node.js 24, npm, Git and Rust:

```bash
npm ci
npm --prefix mobile ci
npm run dev
```

`npm ci` also points Git at the repository's hooks in `.githooks/`: pre-commit runs formatting, lint and type
checks on what you stage, and pre-push refuses a push to `main`.

## Make the change

- Work on a branch with a descriptive name, such as `fix/composer-paste-image` or `docs/host-pairing`.
- Keep each pull request to one fix, feature or refactor.
- Preserve the shared experience across Codex, Claude Code and the admitted ACP agents: shared behavior lives in
  shared services, and each agent's protocol stays inside its adapter.
- Consider macOS, Windows and Linux, remote Hosts and the phone client for every change that can reach them.
- For interface work, follow the [style guide](../docs/style-guide.md) and the [interface copy guide](../docs/ui-copy.md).
- Give every new source file a one-line comment at the top that says what it owns; `npm run module-map -- --check`
  checks it. The [code quality guide](../docs/code-quality.md) explains file size limits and naming.
- Never commit credentials, personal data, or code, strings or assets copied from other products.

## Test it

Changed behavior needs focused unit tests with 100% line, branch and function coverage of the changed code. Find
the tests that reach your change, then run them with coverage:

```bash
npm run test:related -- --direct <changed-files>
npm run test:coverage -- --changed --related
```

For a bug, add a test that fails before the fix, and follow [bug prevention](../docs/bug-prevention/README.md):
name the bug's class, fix the same mistake elsewhere and add a guard. [Unit coverage](../docs/unit-coverage.md)
explains the measurement.

Before you push, format your files and run the static checks CI runs:

```bash
npm run format -- <changed-files>
npm run lint
npm run typecheck
npm run module-map -- --check
npm run i18n:check
```

When a coding agent validates a change in the running app, give it CI, a virtual machine or a spare user account,
not the desktop you are working on: a test instance can take focus, click in your windows and use your sign-ins.

## Open the pull request

Fill in every section of the [pull request template](pull_request_template.md): the problem and the resulting
behavior, the invariant you changed, how you validated it (commands, test counts and coverage), the risk, and what
you could not check. Link the issue it addresses. Attach before and after screenshots or a recording for interface
changes.

A maintainer reviews the change once CI is green. Releases, version numbers and signing are handled by the
maintainers; leave them out of contributions.

## Get help

Ask on [Discord](https://mopilot.ai/discord), or open an issue with the bug report or feature request form.
