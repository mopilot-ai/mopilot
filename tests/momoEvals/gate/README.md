# MoMo gate and notes evaluation suite

This suite gates any change to MoMo's approval gate, notes or learning: a model, prompt, rule or `shared/momoCore/` change is not done until it passes. It is adversarial: seeded random sequences and hostile inputs look for the ways the reviewed unit tests did not.

## Run it

```
node --test tests/momoCoreAdversarialGate.test.ts \
            tests/momoCoreAdversarialNotes.test.ts \
            tests/momoCoreAdversarialLearning.test.ts \
            tests/momoCoreAdversarialRules.test.ts
```

Pure TypeScript, no dependencies, under 5 seconds in all. CI runs the same files with the rest of the unit tests.

## What each file checks

| File | Properties |
| --- | --- |
| `momoCoreAdversarialGate.test.ts` | A card is used once and only for its own action, chat and origin; a tainted or unprompted run never acts without a card; every state change that lets an action run has its audit line first; the audit chain verifies and carries no arguments; concurrent answers and uses |
| `momoCoreAdversarialNotes.test.ts` | Forged, altered, invisible-character, homoglyph, reversed or unrelated quotes never create, change or retire a line; mail never confirms; a tainted or background pass never makes a Confirmed line; planted orders and secrets are never kept; undo and tidy restore the notes exactly |
| `momoCoreAdversarialLearning.test.ts` | No allow rule survives the latest deny; two consistent reactions suggest, an opposite one cancels, silence never counts, quieter starts on, more waits (checked against an independent model); labels are sanitized; words never become gate rules |
| `momoCoreAdversarialRules.test.ts` | More of rakazo's approval cases (Apache-2.0, see the file header and `shared/momoCore/NOTICE`), rule order permutations, glob escaping, wildcard cost |

The 49 cases of `tests/support/momoCore/rakazoApprovalCases.ts` are already run by `momoCoreGate.test.ts`; this suite adds cases and does not repeat them.

## What a failure means

- A normal test fails: the change broke a guard. The message names the seed and step (`seed 12 step 31 ...`). Replay it by calling `walk(seed, steps)` (gate) or the same seed in the named test; the generator is `mulberry32` in `tests/support/momoCore/adversarialKit.ts`, so the run is identical every time. Fix the code, not the test.
- A `todo` test is a known, still open finding (`F1` to `F10`). CI stays green, the run prints it as a failing todo with its reason. When you fix the finding the test starts to pass: delete the `{ todo: ... }` option so it becomes a guard.
- Never loosen an assertion or raise a bound to make a run pass. If the property itself was wrong, say why in the PR.

## Add a case

1. Reproduce the bug in the smallest deterministic test. Put it in the file for its area, as a normal test if it passes today, or with `{ todo: 'F<n>: one-line reason' }` if it fails today. It must really fail on the current code.
2. If a random walk could have found it, add the property to the walk (a new `assert` in the loop) rather than only the single case, so the next variant is found too.
3. Invented data only: no real names, addresses or mail. Use `\u` escapes for any non-ASCII text.
4. Keep each file under 5 seconds: raise the number of seeds only if the run stays fast.
5. For a ported case, keep the licence notice and the "changed" marking in the file header.

## Limits

These are properties of the pure core. The Host (card store, audit log on disk, the choice of `scope`, `tainted` and `origin` for each request) and the models' own behaviour are checked elsewhere. The triage, home and move, and brief sets in the design (section 3.5) are separate suites.
