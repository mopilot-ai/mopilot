# Notice evaluation: how a change is gated

Three files test the notice pipeline (`shared/momoNotice`) with invented data, deterministic seeds and no network:

| File | What it checks |
|---|---|
| `tests/momoNoticeAdversarialTriage.test.ts` | 150+ labelled items (see `GUIDE.md`) run through the real pre-checks, sender check, limits and decision record with an **oracle model** that answers the label (or, for traps, the wrong answer). It finds where the code around the model silences or mislabels something. |
| `tests/momoNoticeAdversarialLimits.test.ts` | Seeded random days: the cap, quiet hours and once-per-matter in seven zones around DST changes; first connect, catch-up, snooze, restart, two zones, matter poisoning. |
| `tests/momoNoticeAdversarialBrief.test.ts` | Exactly one brief per home-day under clock skew, DST, zone change and restart; none in quiet hours; none on a quiet day. |

Run one file: `node --test tests/momoNoticeAdversarialTriage.test.ts` (no install needed). Set `MOMO_EVAL_OUT=/path/verdicts.jsonl` to write one verdict line per item.

## Gating a prompt, model or rule change

- A change to `reading.ts` (the prompt), a rule in `preChecks.ts`, `senderCheck.ts` or `limits.ts` must keep these files green and must not add an item to `knownGaps.ts`.
- A **known gap** (`knownGaps.ts`, `GAPS` and `FINDINGS`) runs as a node:test `todo`: it fails today, shows in the report, and does not turn CI red. When you fix one, the todo starts passing: delete it from `GAPS`.
- A new model or prompt is judged with the existing `eval/triageEval.ts` gate on the 62 mails **and** by running these items with the real model in place of the oracle (swap `oracle()` in `run.ts`); the numbers to watch are items missed (tell_now or track answered quiet) and over-alerts.
- To add a case: append one `add(...)` line to `items.ts` following `GUIDE.md`, run the file, and either fix the code or add the item to `GAPS` with a finding.
