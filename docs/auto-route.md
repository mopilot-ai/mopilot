# Auto model routing

Auto lets MoPilot choose the model and effort for a chat, and optionally the harness too. There are two modes.

- **Auto (harness)**: the chat stays on its harness, and every turn gets a model and an effort.
- **Auto (all harnesses)**: also called Global Auto. It first decides which harness the chat runs on, then picks the
  model and effort for each turn the same way.

A chat's mode is saved in `meta.config.autoRoute` (`'harness'`, `'global'`, or absent/null for picking by hand). New
chats start in `prefs.autoRouteNewChats`. The model menu's former "Automatic" entry is now **Default (recommended)**: it
saves no model and uses the harness's recommended one, with no routing.

## Harness Auto

- **Where it runs**: in main, at the controller's `beforeDispatch` hook (`electron/autoRoute/service.cjs`, installed by
  `electron/app/autoRouteWiring.cjs`). It runs only for written turns. It skips steers, compaction and goal restarts,
  and leaves alone a turn whose model or effort someone set explicitly (scheduled tasks, Host sends).
- **The router**: the local SquillaRouter ([auto-route-squilla.md](auto-route-squilla.md)). It reads the request, the
  last four user requests, the previous answer and the route history, and returns a tier (C0–C3) and a thinking mode
  (T0–T3).
- **Tier to model**: each harness gets a ladder of models (`shared/autoRoute.mjs`). The ladder keeps the newest model
  of each size class (nano/lite, mini/haiku/flash, standard, opus/pro/max, Claude's largest families), cheapest first.
  An alias is ranked by the model it resolves to, and the plain name wins over a variant. Claude Code's ladder is
  therefore haiku / sonnet / opus, never the older pinned versions under "More versions", which `catalogOf` leaves out.
  - C0 runs on the cheapest step and C3 on the strongest.
  - C1 and C2 spread between them.
  - A harness with only one size class routes only the effort.
  - `prefs.autoRouteTiers[family]` overrides a tier with a model the harness lists.
- **Thinking to effort**: the thinking mode becomes the offered effort nearest to none / low / medium / high. A tie goes
  to the higher level.
- **Cache-aware hysteresis** (`electron/autoRoute/sticky.cjs`):
  - A stronger tier applies at once.
  - A tier one step cheaper applies only when asked for twice in a row, so one easy turn does not throw away a warm
    prompt cache.
  - Two steps cheaper applies at once.
  - After a failed turn the tier never drops.
- **Per turn only**: the choice goes into that turn's `opts.model` / `opts.effort`, which Codex and Claude Code apply
  per turn (an ACP agent through set and restore, below). The chat's saved selection stays unchanged, and it is also
  the fallback.
- **Retries**: a retried message first drops what Auto set for its earlier attempt. It is then routed again as the same
  turn, or runs on the chat's own selection if Auto is now off.
- **Fallback**: if anything fails, the turn runs on the chat's own selection and the decision says why. Examples: the
  harness lists no models, there is no text, the router is unavailable (no weights, or macOS x64), or the router takes
  longer than 250 ms or rejects.
- **ACP agents (set and restore)**: an agent's config option outlives the turn it is set for, so Auto sets the
  model and effort (its `model` and `thought_level` select options) for the turn, and the chat's own come back with
  its next message on that agent (`electron/autoRoute/acpRestore.cjs`, `electron/harness/acp/initialConfig.cjs`).
  - Before the pick reaches the agent, each value it changes is written to `meta.config.autoRouteRestore`, keyed by
    agent, against the chat's own value, so a crash keeps it.
  - The chat's next message on that agent, Auto or not, hands each value it leaves alone to the ACP adapter. Once the
    session is open, and before the prompt, the adapter sets the chat's own back where the agent still runs Auto's
    value: a value someone picked since stays, and a value the agent no longer offers isn't set.
  - A turn the agent took clears what it set back, unless a later turn wrote a newer record (a generation number). A
    start that failed keeps the record for the next message. Between messages, the agent shows the last turn's pick.
  - Each changed value costs one extra `session/set_config_option` call, made at the next message, and the agent's
    items log records it.
- **Memory**: per-chat router memory covers the last requests, the previous answer, the route history and the
  pending downgrade. Auto keeps it for the 200 most recently routed chats, in memory only.

## Global Auto

- **Where it runs**: at the controller's `beforeStart` hook, before the turn settles any pending switch.
- **Scoring**: HM-Router's published results (`electron/autoRoute/hmTable.json`, built by
  `scripts/build-hm-table.mjs` from `github.com/hmarkc/HM-Router` `data/`) score each harness that can take the chat
  now. The chat's own harness is always scored. A harness HM-Router never measured is not a candidate.
  - Words pick the benchmarks: the request's words are compared with each benchmark's query centroid, giving
    benchmark weights.
  - Lead per model: each benchmark's result is smoothed toward that benchmark's average over every pair. The harness
    scores by how far above that average it did, weighted by the benchmark weights. A benchmark it never ran neither
    helps nor hurts it.
  - Models offered here: a model counts when HM-Router measured it, or else its family's newest measured version
    ("claude-opus-5-5" counts as "claude-opus-4-8"). When none match, the harness is judged by all its measured models
    pooled.
  - Price: a cost weight `prefs.autoRouteCost` (low, medium or high) subtracts a price term by size class.
- **When it moves** (`electron/autoRoute/globalPolicy.cjs`):
  - On the chat's first Auto turn, to the best-scoring harness if it leads by at least 0.02.
  - Later, only when another harness leads by at least 0.06 for two turns in a row.
  - Or when the current harness failed two turns in a row and another scores higher.
  - Never within four turns of the last move.
- **Bounded wait**: the harnesses are read in parallel under one 500 ms deadline, and each model list is reused for a
  minute. A harness that does not answer in time is left out, or scored by its measured models. A Stop during the
  reads keeps the chat where it is.
- **How it moves**: through `sessionSettings.switchHarness`, so the ordinary pending switch and handoff
  (`session/switch.cjs`) carry the conversation. Inside the new harness, Harness Auto then picks each turn.
- **Saved state**: `meta.config.autoRouteState` keeps the turn count and the turn of the last move. The lead and failure
  counts live only in memory.

## Surfaces

- **Pickers**: the model menu leads each harness's models with **Auto** (only for the harness the chat is on). The
  harness list leads with **Auto (all harnesses)**. A basic agent's model values lead with Auto. A model picked by hand
  ends Auto, and a harness picked by hand ends Auto (all harnesses). MoMo chats, whose brain is pinned, offer neither.
- **Model button**: in Auto, the button names the model the last turn ran on ("Auto · Sonnet 5.5") and its effort. Main
  shows the decision as session state `autoRoute`. The effort panel says Auto picks the effort.
- **Agent tools**: `set_session_model` with `"auto"` and `set_session_harness` with `"auto"` turn Auto on for a
  started session, only when the user's words that turn ask for Auto. That means "auto" as a word of its own (not
  auto-fix, auto merge or the auto permission mode) beside a model, harness or routing word. Picking a model by name ends Auto, and picking a
  harness by name ends Global Auto.
