# MoPilot documentation

Start with the [README](../README.md) for what MoPilot is, then the guide for what you want to do.

## Contribute

- [Contributing](../.github/CONTRIBUTING.md): from a clone to a merged pull request.
- [Development guide](development.md): toolchains, running a development instance, checks, packaging and fixes.
- [Interface style guide](style-guide.md) and [interface copy](ui-copy.md): tokens, components and wording.
- [Code quality](code-quality.md): file ownership headers, file size, module boundaries, stylesheets and colors.
- [Unit coverage](unit-coverage.md): finding the tests for a change and the 100% changed-code rule.
- [Bug prevention](bug-prevention/README.md): fixing a bug's whole class, the review checklist and the
  [change contract](bug-prevention/change-contract.md).
- [Interface languages](i18n.md): how interface text is translated.
- [Security policy](../.github/SECURITY.md): reporting a vulnerability privately.

## Architecture

- [Modularization](architecture/modularization.md): domains, layers and where code belongs.
- [Rust core](architecture/rust-core.md): the native core behind startup, idle and hot paths.
- [Multi-harness development](multi-harness/README.md), its [architecture map](multi-harness/ARCHITECTURE.md) and
  [design](multi-harness/DESIGN.md): one interface over several agents.
- [Harness matrix](harness-matrix.md), [native ACP harnesses](native-acp-harnesses.md) and the
  [ACP registry agents](multi-harness/registry.md): what each agent supports.
- [Switching a chat across harnesses](acp-chat-switching.md) and [cross-session messaging](multi-harness/CROSS-SESSION-MESSAGING.md).
- [Feature flags](feature-flags.md) and [naming and compatibility](branding.md).
- [Streaming performance](performance/design.md) and its [measurement](performance/measurement.md).

## Features

- [Built-in browser](browser.md), [browser import](iab-browser-import.md) and [passkeys](iab-passkeys.md).
- [Teach mode and Record a skill](computer-teach-and-record.md) and [Computer History](computer-history.md).
- [Plugins across harnesses](multi-harness/PLUGINS.md) and [Quick Actions and built-in connectors](builtin-connectors.md).
- [Orchestrator chat](multi-harness/ORCHESTRATOR-CHAT.md) and [voice input](multi-harness/VOICE.md).
- [Project navigation](project-sidebar.md), [conversation navigation](codex-conversation-navigation.md),
  [automatic chat titles](automatic-chat-titles.md) and [composer goals](composer-goal.md).
- [Starting a chat from GitHub or Linear](start-from-github.md) and [moving from Conductor](conductor-migration.md).
- [Keyboard shortcuts](keyboard-shortcuts.md).

## Hosts and the phone

- [Host](host.md): run a chat on another machine; [sign-in](host-signin.md), threat model,
  [update authentication](host-update-authentication.md) and [trust recovery](host-trust-recovery.md).
- [Phone client](../mobile/README.md), [relay](../relay/README.md) and [self-hosting the relay](mobile-remote/self-hosting.md).
- Mobile Remote security review, privacy facts and
  [permissions audit](mobile-remote/permissions-audit.md).

## Platforms and delivery

- [Linux desktop builds](linux.md) and [app update delivery](updates.md).
- [Testing across harnesses](multi-harness/TESTING.md) and the [acceptance checklist](acceptance.md).
- [Third-party components](THIRD-PARTY.md).
