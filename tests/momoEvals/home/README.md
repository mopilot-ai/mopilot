# MoMo home and move: failure-injection harness

Scripted, hermetic checks that drive the **real** home, move and turn-ledger code (`host/src/momoHome.mjs`, `momoMove.mjs`, `momoTurns.mjs`, `shared/momoMove.mjs`, `momoMoveRunner.mjs`) through a move of MoMo's home between simulated machines, and cut, lose, repeat and delay every step of it.

## Run it

```
node --test tests/momoHomeMoveFaults*.test.ts
```

The protocol it drives: every machine is created with its own `hostId`; a move is offer, begin, seal (to the target's keys), receive, commit (answers a target-signed receipt), finish (needs that receipt); a failed move is settled on the target's word (`discard` answers a proof or `committed`; `recoverMove`); a sealed move never resumes on a clock, an unsealed one ends itself after the deadline; ended move ids stay closed.

Each file stays under about 5 seconds. No network, no real Host, no app: every simulated machine is its own temp folder (Host key, MoMo data key, home record, stores), a fake clock with a per-machine offset, and a fake link between the app and each Host. Needs the repo's `node_modules` (the home stores load `rrule`) and the generated `shared/harness-catalog.generated.json` (`npm test` makes it).

| File | What it covers |
|---|---|
| `momoHomeMoveFaults.test.ts` | harness controls, an undisturbed move, pause / offer / seal at every fault |
| `momoHomeMoveFaultsRollback.test.ts` | Cancel at each step with the Cancel or discard itself lost; target killed while receiving |
| `momoHomeMoveFaultsSwitch.test.ts` | commit (the switch) and finish (the wipe) at every state change inside them |
| `momoHomeMoveFaultsRaces.test.ts` | replayed conversations, racing moves, stale stamps, turn replays, clock skew, late frames, reconnects |
| `momoHomeMoveFaultsSeeded.test.ts` | seeded (mulberry32) random schedules, 1 to 3 faults over two moves, turns sent mid-move |
| `momoHomeMoveFaultsReceipts.test.ts` | receipts and proofs from another move, machine, epoch, bundle or world refused; deadlines; sealed moves never resume on a clock; clocks skewed past the deadline |
| `momoHomeMoveFaultsDeep.test.ts` | two and three faults in one move, retries without settling, a recovery that is itself cut, moving back and forth |
| `momoHomeMoveFaultsReclaim.test.ts` | the owner's `reclaim` (twice, raced against a late receive and commit, fenced by the real stamp receivers), second seals, receipts replayed from the record of an older move |
| `momoHomeMoveFaultsTurns.test.ts` | pruned (`gone`) and void turn ids across a move, a send that throws mid-move, the newest lease seen kept across a restart |
| `momoHomeMoveFaultsModel.test.ts` | a second model over the pure rules (`shared/host/momoMovePhases.mjs`): two targets, distinct leases, closed ids, receipts naming the sealed bundle, old home always the newer lease beside a target |
| `momoHomeMoveFaultsFindings.test.ts` | the round-1 findings F1-F12 as guards of the fixes; still-open or new findings as `todo` with a minimal reproduction (never turns CI red) |

## What it asserts after every fault

The checks live in `world.ts` (`violations`, `healthy`):

1. **Never two homes acting.** At most one machine has the newest lease and accepts a turn (probed with a real ledger accept). An older home may run only beside a reclaimed old home, and only where the real stamp sink refuses its stamps (`fencedBy`).
2. **Stale epochs refused.** Every stamp ever seen acting, at an epoch below the highest acting epoch, is refused by every machine (`home.current`).
3. **Never a lost home.** Some machine acts, or holds the data and the data key in a stated `moving` / `running` record from which a recovery starts.
4. **No wipe without a target receipt.** A machine that lost its data or key needs another machine running at a newer epoch whose adopted bundle hash was one the old home sealed.
5. **No turn run twice.** A turn id accepted as new on two machines is a violation.
6. After a recovery (`recover`: `recoverMove` with each other machine, then the owner's confirmation once the deadline is past for a target that lost the move): exactly one home acts, the fact is there, the audit chain verifies, nothing staged is left.

## Faults

`Net` (in `world.ts`) is the link. A script of `{ machine, op, kind, nth, k }` decides what happens to a frame: `drop-req`, `drop-resp` (it ran, the answer was lost), `dup`, `delay` (held, delivered later with `deliverHeld`), `flush` (deliver the held frames first), `kill-before`, and `kill-at` with `k`: the machine is killed at its k-th state-changing file call (`faultFs.ts` wraps `node:fs` renames, removes, writes, links and audit appends, so after the kill nothing of that machine's process can change a file). `restart()` is a new process over the same folders.

Kill points are not listed by hand: `killPoints()` runs an undisturbed move and counts each step's state changes, so a new write in move code becomes a new case.

## What a red result means

A failing matrix or seeded test names the case (`B.commit#1:kill-at@7 -> ...`) and the broken invariant. Replay a seeded failure with `runSeed(<seed>)`; the printed trace is the frame sequence. A failure here is a change that can leave two homes, lose the home, delete data early or run a turn twice under a fault: fix the move code, do not widen the harness.

A `todo` in `momoHomeMoveFaultsFindings.test.ts` is a known bug with a minimal reproduction. When the lane fixes one, the todo passes: delete `{ todo: ... }` so it guards the fix.

## Gating a change to move or lease code

Any change under `host/src/momoHome.mjs`, `momoMove.mjs`, `momoBundle.mjs`, `momoTurns.mjs`, `shared/momoMove*.mjs` or the home record shape must keep `node --test tests/momoHomeMoveFaults*.test.ts` green, and should flip the todo of any finding it fixes. A new step, state change or lease rule is covered by the matrix on its own (kill points are discovered); a new rule that needs its own scenario gets a test in the Races file.

## Add a fault point

- A new step in the move: add its name to the `POOL` in `matrix.ts` and a `casesFor([...])` test in the matching file.
- A new kind of link fault: add the kind to `FaultKind` and a branch to `Net.send` in `world.ts`.
- A new invariant: add it to `violations` (must hold at every instant, even with a machine down) or `healthy` (must hold after recovery) and add a control that makes it fire.
- A new scenario: build it from `twoMachines()`, `drive()`, `w.net.faults`, `w.sendTurn()` and `recover()`; keep it under a second.

## Limits

Fencing today is local to each Host: nothing outside the Hosts (a relay authority) holds the compare-and-swap yet, so a machine that was never told of a move cannot be fenced by it. Disk time is virtual (fsync is a no-op); crash points are between file calls, not inside one. The client app, the relay and a real network are not part of this harness.
