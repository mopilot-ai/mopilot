# Bug prevention

How to fix a bug so that its whole class stays fixed, the lint ratchet that blocks new instances of the
mechanical classes, and the bug classes this repository keeps producing. Each class has its own file in this
folder (see [Bug classes](#bug-classes)).

## Where these rules come from

A review of the 507 pull requests merged up to #546 (October 2026) found 233 bug fixes. Missing tests were not
the problem: almost every fix added a unit test. The problem was that each fix repaired one call site, and the
same mistake was fixed again later somewhere else:

- Keeping a refused message queued took five pull requests, one per start path in
  `electron/session/controller.cjs` (#502, #517, #518, #519, #520).
- Git path handling took nine consecutive pull requests (#486–#494). The "stuck turn preview" in
  `TurnNavigation.tsx` was fixed three times (#335, #340, #353). The chat-versus-global account bug was fixed
  three times (#152, #167, #263).
- A guard landed incomplete and needed a second pull request (#543, then #544), a first root cause was wrong
  (#395, then #398), and a cancellation broke a flow that relied on the old behavior (#479, then #516).
- Six times main went red because a whole-repository test was not among the tests a pull request ran
  (#150, #174, #217, #255, #268, #273).

So the rules below aim at three things: fix the class rather than the instance, block the mechanical classes
with lint, and select the relevant invariant checks for every pull request.

## Fixing a bug

1. **Reproduce it** with a meaningful test that fails on the current code (AGENTS.md). Use focused UT for logic;
   layout, packaging and wiring may need another reproducer layer plus UT for separable behavior.
2. **Name the class** from [the classes](#bug-classes) below, or describe a new one.
3. **Sweep for siblings.** Search for the same pattern across the repository (each class lists what to search
   for) and fix every instance in the same pull request, with a test for each behavior. If an instance is left,
   say why in the pull request. Check the other harnesses, the other start/send/stop paths, and the
   main-process and renderer copies of the logic.
4. **Guard the class.** When a pattern can be matched mechanically, add or extend a rule in `lint/rules/` (see
   [the lint ratchet](#the-lint-ratchet)) or a whole-repository test. Otherwise move the logic behind one shared
   helper so there is a single place to get it right.
5. **Improve the workflow.** Name the workflow step that should have caught the bug before it merged (the
   change contract, a failure scenario, the [review checklist](#review-checklist), a skill, AGENTS.md, a hook,
   the merge gate or a CI check) and why it missed. When the workflow let it through, fix that step in the same
   pull request, preferring an enforced check over more prose, so the next agent following it catches the
   same mistake.
6. **Check what the fix changes.** A new guard or cancellation can break a flow that relied on the old behavior;
   test the flows that share the changed code, not only the reported one.
7. **Verify the fix** against the original repro, once, in the real environment, before it merges
   ([below](#verifying-the-fix)). A passing unit test shows the code does what the test expects, not that the
   user's bug is gone.
8. **Describe it** in the pull request under *Root cause* (the class and why the code allowed it), *Sibling
   sweep* (what you searched, what you fixed, what you left and why), *Guard* (the rule, test or helper that
   stops it coming back, or why there is none), *Workflow* (the step that missed it and how it changed, or
   why no change is needed) and *Verified the fix* (below).

The [fix-bug](../../.agents/skills/fix-bug/SKILL.md) skill runs these steps.

## Verifying the fix

#1579's computer-use pill could not be clicked. Its fix (#1590) merged on unit tests alone, with "left for the
release run" in place of a check, and nobody clicked the pill. So every bug fix reproduces the original report
once in the real environment, with the fix in place, before it merges:

Where the check runs: a real app on CI, in a virtual machine, or under a spare user account, never on the desktop
someone is working on. A test instance shares that desktop's screen, input, sign-ins and data, so it can take focus,
click in other windows or show in the user's own chats. Check layout at the narrowest window too (1024×682 with the
side panels open), and text beside icons at a larger Chat font size.

**Scripts, CI and other code with no app around it** are checked by the real command against the real input that
failed, in a fresh tree (`git worktree add` or a new clone), since a developer's checkout keeps ignored build output a
clean runner never has.

This is one targeted check of the reported steps, not the end-to-end suites. Record it in the pull request under a
`## Verified the fix` heading: the steps, the environment, what happened, and timings or a screenshot. When the bug
has no real-app repro (a fix to a test, a lint rule or a fixture), say why under the same heading.

## Change contracts and failure scenarios

Before implementing behavior, follow [the change contract](change-contract.md): name its invariant,
owner, invalidators and overlap policy, then choose the applicable failure scenarios. They complement
100% changed-behavior coverage: executing a branch does not establish that old requests, new contexts,
malformed responses or competing writers were tested. Keep this evidence in the PR, not in these docs.
The same page defines concrete sibling-sweep outcomes, adversarial review and recurrence records.

## The lint ratchet

Biome reports the mechanical bug classes as warnings: the GritQL rules in `lint/rules/*.grit` and the
warning-level rules in `biome.json`. They apply to the app's sources (`src`, `electron`, `shared`, `scripts`),
not to tests. The code already had about a thousand of them, so instead of failing on every warning, the
ratchet keeps the number from growing. `lint/baseline.json` holds each file's count per rule:

- the pre-commit hook fails when a staged file's count for a rule goes up, and lists that rule's warnings in
  the file;
- when a count goes down, the hook lowers the baseline and stages it with the commit. Biome reads the working
  tree, so a file with unstaged edits never lowers the baseline and untracked files are left out;
- the pull request check (`unit-tests`) runs `npm run lint:ratchet -- --base=origin/main`, which fails when a
  file the pull request changes is above its count or a rule's total in the baseline is above main's. A file it
  does not change can be above its count when a pull request branched before the ratchet added a warning; the
  next change to that file fixes it.

Commands:

    npm run lint                                  lint errors, then the ratchet for your changes against origin/main
    npm run lint:ratchet                          check every file
    npm run lint:ratchet -- --update <files>      record counts after moving code between files

`--update` refuses to raise a rule's total, so moving code between files is fine and adding a warning is not.
Fix the warning instead; when a match is a false positive, make the rule more precise. Do not raise the
baseline by hand, and do not add ignore comments to pass.

To add a rule, write `lint/rules/<name>.grit` with a `[name]` tag at the start of its message and a link to its
class's file in this folder, list it in the `biome.json` overrides, then run `npm run lint:ratchet -- --update` to record its
starting counts. A new rule's total starts free; after that it can only go down. A rule with no warnings is
recorded as `"<rule>": {}` (add that by hand for a rule that starts clean): a rule the baseline lacks counts as
new, so a rule fixed down to zero stays in the baseline that way, and `lintRatchet.test.ts` checks that every rule in
`biome.json` and `lint/rules` is recorded. Prefer rules with few false positives: a rule people learn to ignore
protects nothing.

Each rule of ours names its class in its message and links the class page, and `tests/lintRuleClasses.invariant.test.ts`
checks that, so a warning leads to its class and no table lists the rules for every new one to edit. To list a class's rules, search `lint/rules` for its page (`grep -l keyboard-and-focus lint/rules/*.grit`). Biome's own rules:

| Rule | Class |
|---|---|
| `lint/nursery/noFloatingPromises`, `lint/nursery/noMisusedPromises` | [Swallowed errors](swallowed-errors.md) |
| `lint/correctness/useExhaustiveDependencies` | [Stale async results](stale-async-results.md) |
| `lint/suspicious/noArrayIndexKey` | [Identity collisions](identity-collisions.md) |
| `lint/a11y/useKeyWithClickEvents` | [Keyboard and focus](keyboard-and-focus.md) |

`useHookAtTopLevel` is an error everywhere.

## Bug classes

Each class says what the bug looks like, where it came from, what to search for when sweeping, and the
question a reviewer should ask.

| Class | What it looks like |
|---|---|
| [Stale async results](stale-async-results.md) | A result applied after its chat, turn, draft or process changed |
| [Wrong scope](wrong-scope.md) | State or a cache keyed by less than its real identity |
| [Stuck state](stuck-state.md) | A state cleared only by an event that may never come |
| [Swallowed errors](swallowed-errors.md) | A failure turned into success, an empty result or an endless spinner |
| [Lost user input](lost-user-input.md) | A draft, message or setting dropped when the send is refused or fails |
| [Overlapping operations](overlapping-operations.md) | Two operations at once where one was assumed |
| [External contracts](external-contracts.md) | Behavior assumed of a CLI, protocol, library or OS it does not have |
| [Strings, paths and keys](strings-paths-and-keys.md) | User text and file names that break parsing |
| [Identity collisions](identity-collisions.md) | Two things with the same id |
| [Cross-harness gaps](cross-harness-gaps.md) | A feature that works for one harness, or only with a window open |
| [Edge states](edge-states.md) | First run, empty, missing, -1 or already aborted |
| [Keyboard and focus](keyboard-and-focus.md) | Keyboard, focus and accessibility mistakes |
| [Misleading error text and silent opens](misleading-error-text-and-silent-opens.md) | A failure told in words that hide it, or not told |
| Merge-gate gaps | A pull request that passed its tests and broke main |
| [Load-dependent tests](load-dependent-tests.md) | A test that passes alone and fails under load |
| [Time and order assumptions](time-and-order-assumptions.md) | A throttle, debounce or cache that decides by the clock what only the order can decide |
| [Render cost](render-cost.md) | A drag, frame or poll whose work grows with what is on screen, not with what changed |
| [Data at rest](data-at-rest.md) | A secret or user content on disk, or a secret on a command line, that others can read |
| [Unreachable features](unreachable-features.md) | A feature built and tested that nothing in the app calls, so it exists only in its tests |

### Adding to a class

Each class has its own file: what the bug looks like, what to search for and ask, then its notes. A pull request that
teaches something about a class (an incident, a rule it learned, a new place to search) says so in its description,
and a maintainer records it as a note. Edit a class's description or search list in a pull request of its own. A new
class gets a new file, a row in the table above and a link from its lint rules.

## Review checklist

For every material code/contract change, and every sibling a bug fix touches, a fresh reviewer (`code-review`
with `--fix` in Claude Code, `/review` in Codex) checks the diff against these questions and classes before
publication. Record the source, contract and relevant dependencies reviewed. Metadata-only PR updates may retain
that matching review; changed behavior or relevant dependencies require renewed review. This is the ut-pr-merge
skill's review gate:

1. After each `await`, is the context still the one the work started for? An id a card, button or toast action
   captured when it rendered is a claim, not proof: does the handler that takes it check that it still names a live
   entity of the current process, and does the caller read the refusal instead of counting the action as done? A value
   captured with it (a model, a pin, an offer's contents, a message sent first) is a claim too: is it read again at the
   click, and does a step that can't be undone (a message sent) wait until main took the claim?
2. Can it run twice at once, or overlap another writer?
3. Where do the user's input and the failure go when it is refused or throws? A stop or refusal the app makes on purpose: does the transcript keep why, and is the model told? What does the user read: a sentence (`userError`, a reason table), never a code, stderr, an exit code or a path? Text a tool result holds to a length (a page's text run, a field value, another chat's message): does the cut say how much it left out and where the rest is read (`clip` and `clippedNote` in `shared/clippedText.mjs`), so the model never takes a cut for the end (`tests/modelTextCut.invariant.test.ts`)?
4. Is it scoped to the chat's own account, folder and harness, and is every cache key complete? An agent tool argument that moves work elsewhere or re-prices it (a harness, a model, an effort, a place): does it default to the chat's own and stand only when the user's own words named it (`userChoice` in electron/session/userWords.cjs, `tests/agentChoiceOwner.test.ts`), never on the agent's judgment?
5. What clears each pending state if the expected event never comes? A state only the user ends (a take-over, a hand-off): does the call wait for them, or does the state outlive the turn, given what the model does with the result text (it ends its turn on "paused" or "stopped")?
6. Does it work for every harness, with no window open (none of MoPilot's, and none of the user's Chrome, which keeps running windowless on macOS), in a window that opens only after the work is done (the window's first reads, with no change to come), and in one that opens or reloads while the work runs (does it read the running state from main, which owns it, rather than guess it from a transcript)? What calls it in production? Does its copy name the chat's own harness, or none, rather than the default harness or a fallback to one?
7. What shows that the external tool or protocol behaves as assumed? Is the protocol flag or call run for real in a unit test (V8's inspector for CDP, a real server), not only against a fake reply written from the same assumption? Where the change reads data another module produces (a transcript's turns, a store's records), are its tests' inputs made by that producer, not written by hand? A limit on what a chat may do (its tools, files, instructions): where does each harness run that capability, and is it refused there? An ACP agent runs its own tools inside its process, never through the client's fs/terminal methods (#2278). When the change lets go of something a harness holds (a thread, a session, a CLI), what measurement shows the process tree (its child processes and their footprint) actually shrinks?
8. Were the same pattern's other instances found and fixed? A change to UI copy or a button's name: were the E2E specs that pin the old text (`grep -rn` it in `tests/e2e`) updated too? The pull request check runs the ones it picks: the Linux ones hold the merge (`e2e-specs`), the macOS ones only advise (`e2e-specs-mac`; docs/unit-coverage.md#e2e-specs), and the ones it does not pick run only on main. A change to a rule that decides what a surface shows (which rows a list keeps, when its empty state appears) removes no text, so the check picks no spec that asserts it: were the journeys that make what the rule now hides found (`grep -rn` the surface's selector in `tests/e2e`), and does each journey that asserts the surface without importing it declare the surface's owner (`// e2e-covers:`, docs/unit-coverage.md#e2e-specs)? A change to what an agent tool does: were the E2E specs that call it (`grep -rn <tool name> tests/e2e`) updated to the new contract? Does model-facing text (tool descriptions, refusals, notes) that names the button read the same constant as the button (`shared/doneContinue.mjs` for "Done, continue")?
9. On a continuous input (a drag, a resize, a poll), does one event's work grow with what is on screen? Does it set
   React state per mouse event, re-run an effect over a dependency built during render, change a custom property
   inherited by thousands of rows, or replace data a poll read unchanged? Was it measured on a large case
   ([render cost](render-cost.md))? Does a size it writes (a height set from a `ResizeObserver` or a measure) change
   the size it reads, for example a scroller with no bounded height in a new host? Bound it by something it does not
   size, such as the window.
10. Does each changed file still own one responsibility, especially above 400 lines? Extract a cohesive module when useful; review any new file-size cap and its reason in `lint/file-size-exceptions/` (a file of your own per pull request).
