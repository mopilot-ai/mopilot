# Third-party code in `shared/momoTasks`

The licence text ships in `build/THIRD_PARTY_NOTICES.md` (feature file `scripts/third-party/momo-tasks.json`, text in `docs/licenses/rakazo-LICENSE.txt`).

| File here | From | Licence | What we did |
| --- | --- | --- | --- |
| `watch.ts` | rakazo `packages/contracts/src/routines/routine-watch.ts` and the pure parts of `packages/adapters/src/routines/routine-watch.ts` (`stableStringify`, `readItems`, `compareReading`, `describeEntryChanges`, the interval bounds, the read-only tool rule) | Apache-2.0, Copyright 2026 Rakazo contributors | Ported. **Changed:** zod is replaced by a hand-written `parseWatch`; the `command` kind, the MCP result envelope, vault, sandbox and secret redaction are left out; the HTTP kind keeps rakazo's URL rules (HTTPS, no credentials, port or fragment) but the fetch is an injected reader; outcomes are returned and stored by the caller, never written to a database. |

rakazo's `NOTICE` file lists third-party code in other parts of rakazo (a Grok import adapter); none of that code is used here, so it is not repeated.
Nothing here comes from an AGPL or GPL project.
