# Starting a chat from GitHub or Linear

The new-chat branch picker's search takes `#12`, or a GitHub pull request's or issue's link, and offers what it names in the folder's `origin` repository. Main resolves it (`electron/platform/startSource.cjs`). gh is always pinned to origin with `--repo`, and a link to another repository is refused.

- `#12` is origin's pull request when one exists, else its issue. GitHub numbers both in one series. A pull request's link is only ever a pull request. An issue's link whose number is a pull request (GitHub redirects it there) is offered as that pull request.
- **A pull request** (`electron/platform/prSource.cjs`): the chat works on its head. With Worktree on, the worktree checks out origin's open branch, or a copy, `pr/<n>`, for a fork's pull request or one no longer open. With Worktree off, origin's open branch is switched to in the folder; a copy is refused there.
- **An issue** (`electron/platform/issueSource.cjs`): the chat starts as it would with no issue, on the branch picked before it, or on the default for the Worktree switch. The issue is read again when the chat starts. Its first message carries the issue's title and text as a hidden prefix, the same path a handoff summary takes. The chip above the composer names it and can drop it. A voice chat has no typed first message, so it neither reads nor uses up a picked issue.

## Linear

With Linear connected (Settings → Connections → Linear), the same search takes a Linear issue's key (`ENG-12`, upper case as Linear shows it) or its `linear.app` link (`electron/platform/linearSource.cjs`). Without Linear connected, such a key is a branch search like any other, and with it, branches named like it stay listed under the issue.

- **The key.** It is the user's own personal API key, pasted by them. It is checked with Linear (`viewer`), kept encrypted with safeStorage in an owner-only file under the app's data folder, and only its last four characters are ever shown. It goes to `api.linear.app` and nowhere else.
- **Reading the issue.** The issue is read again when the chat starts, and its text is carried like a GitHub issue's (below). Linear's errors are said plainly: a revoked or wrong key, rate limits, no answer, and an issue no one can see. An outage is never reported as a missing issue.
- **The worktree's branch.** With Worktree on, the worktree works on the branch name Linear suggests. In order:
  - Never the base or origin's default branch, and never a branch of the user's own: those get the usual name.
  - A branch of that name on origin (pushed earlier, or from another Mac) is fetched and tracked.
  - One MoPilot made here before is worked on as it is.
  - Otherwise a new branch is made from the base, tracking nothing.

## Issue text is data

Anyone may have written the issue, on GitHub or on Linear. The prefix therefore (`shared/quotedTask.mjs`, shared by both):

- introduces the issue as a description of the work, not instructions;
- removes what GitHub does not show (HTML comments, zero-width and direction-changing characters);
- fences the text with a fence longer than any backtick run in it, after a cut at 20,000 characters;
- ends with a line saying where the user's own message begins.

Like every prefixed message, the first turn of a chat started from an issue is not the user's word (`isUserTurn`, `electron/session/userTurn.cjs`). The gates that act on it (start_session with user authority, hand-offs, offers, main repair) do not accept that turn, even for what the user typed in it. This is deliberate: text from the issue could otherwise borrow the user's authority. The user's next message is their own turn again.
