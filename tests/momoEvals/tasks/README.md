# MoMo tasks: interleaving gate

`tests/momoTasksInterleavings.test.ts` drives the real task manager (`shared/momoTasks/`) with fake machines, brain, chat and store, through 300 seeded random sequences of 40 steps (plus 100 quiet ones). Operations: create, start/retry (optionally on another machine), stop, session events (progress, needs_you, resumed, finished, failed, lost) aimed at ANY session ever started, so late, duplicate and old-attempt events happen constantly, silent finishes, recover, flush, a machine going offline, Host refusals and thrown starts. About a third of the steps race two operations. Wall time is a few seconds.

## Run

    node --test tests/momoTasksInterleavings.test.ts tests/momoTasksInterleavingsFindings.test.ts

(In a bare worktree the generated `shared/harness-catalog.generated.json` and the markdown packages must exist; CI has them.)

## Checked after every step

- No orphan session: every live session belongs to exactly one open (working or needs_you) task; a task never has two live sessions; a working task points at a live (or silently finished) session.
- At most one card delivered per (task, settle); a card never changes content under its key; at the end the latest settle of every task is delivered exactly once.
- Terminal stays terminal: done never moves; failed or stopped only move through an explicit start/retry that makes a NEW attempt (attempts + 1, new session).
- Events for a session that is not the current session of an open task change nothing.
- Stop is idempotent (a session is stopped at most once); attempts never pass the cap (6).
- Create is a working task or says why (`lastError`); "too many active" only with five working, and never a sixth working task from create.

## A failure

The message names `seed N step M` and prints the operations of that step. Reproduce by setting the seed loop in the first test to `for (let seed = N; seed <= N; seed++)`: the same seed gives the same run. A failure means the task code broke one of the rules above, not that the test is flaky.

## Findings

`tests/momoTasksInterleavingsFindings.test.ts` holds minimal scripted reproductions. A `todo` test fails on today's code (a reported defect, not a red PR); when the code is fixed it starts passing and the `todo` option is removed. The random suite avoids those known paths (no cardless needs_you, no two concurrent retries of one task, no retry past five working) so it stays green and keeps gating everything else; remove the avoidance when the finding is fixed.

## Add an operation

Add a variant to `Op`, produce it in `chooseOp`, run it in `run`, and extend the checks in `checkInvariants` if it can change a rule above. Keep the generator seeded (`rng`) only.
