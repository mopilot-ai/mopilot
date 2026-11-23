# Multi-harness development

MoPilot hosts Codex, Claude Code and admitted ACP harnesses. The shared behavior, adapter boundaries and current data flow are described in [ARCHITECTURE.md](ARCHITECTURE.md).

## Getting started

Read the repository's [agent policy](../../AGENTS.md) before changing code. It owns test scope, app-launch restrictions, review requirements and merge authorization.

For the area you are changing, use:

- [Architecture](ARCHITECTURE.md) for implementation ownership and supported harness behavior.
- [Unit coverage](../unit-coverage.md#checking-an-ordinary-change) for focused test selection and enforced coverage.
- [Testing guide](TESTING.md) for fixtures and links to validation procedures.
- [Bug prevention](../bug-prevention/README.md) for change contracts, sibling sweeps and verification.
- [Module boundaries](../architecture/modularization.md) for dependencies and shared services.

## Feature references

- [ACP forms](ACP-FORMS.md): question ownership, schema limits and provider evidence.
- [Plugins](PLUGINS.md): installation, trust and delivery across harnesses.
- [Journey coverage](JOURNEY-COVERAGE.md): the journeys and their test evidence.

## Merging

Follow the current [pull request check](../unit-coverage.md#pull-request-check) and [merge procedure](../unit-coverage.md#merging). The repository policy remains authoritative when an older design or handoff note describes a different workflow.

## Historical design and handoff

The original migration plan is retained as reference:

- `design-v2.json` and [DESIGN.md](DESIGN.md): target design and readable summary.

These records do not prescribe the current test or merge workflow.

