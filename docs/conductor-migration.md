# Moving from Conductor

How MoPilot takes over a Conductor user's local setup, and where it differs. The public version of this page is
`web/app/(site)/conductor/page.tsx`; its feature table is `web/lib/conductorGuide.ts`. Keep the two in step.

Conductor's formats here come from its documentation (workspaces, `.conductor/settings.toml`, `conductor.json`,
files to copy). They have not been checked against a live Conductor install.

## What the import does

- **Discovery** (`electron/platform/conductorImport.cjs`) looks in `~/conductor/workspaces/<repo>/<workspace>` and in
  `<project>/.conductor/<workspace>` of every known project. A folder counts only when git itself lists it as a linked
  worktree of a repository with its own checkout. Conductor's database is not read.
- **Import** adds each repository as a project and **adopts** each workspace in place
  (`electron/platform/worktreeAdopt.cjs`): a marker file, `mopilot-worktree.json`, is written inside
  `<repo>/.git/worktrees/<name>/`. Nothing in the workspace, its branch or its commits changes.
- An adopted worktree is never removed, pruned or cleaned up by MoPilot, and archiving a chat in it runs no cleanup
  script. Removing it is done in Conductor or with `git worktree remove`.
- The import is offered on the welcome page and in Settings → Worktrees only when there is something to import. It is
  safe to repeat.

## Working in an imported workspace

A new chat's context bar shows **Workspaces** for a project that has adopted worktrees. A chat started in one runs in
that folder on the branch it has; no worktree is made and no branch is switched. Chats that Conductor itself held are
not imported.

## Scripts and variables

`electron/platform/environmentSource.cjs` resolves a repository's environment from, in order:

1. `.codex/environments/environment.toml`
2. `.conductor/settings.local.toml` over `.conductor/settings.toml`
3. `conductor.json`

| Conductor | MoPilot |
| --- | --- |
| `scripts.setup` | Setup script, run in each new worktree |
| `scripts.archive` | Cleanup script, run before a worktree MoPilot made is removed |
| `scripts.run.<id>.command`, legacy `scripts.run` | Actions in the chat's menu |

Conductor's files are read each time and never rewritten. Settings → Worktrees → Environments shows them read-only
with **Convert to environment.toml**. Config that cannot be read is reported with its file and reason.

Scripts and terminals in any managed or adopted worktree get `MOPILOT_*` and the same values as `CONDUCTOR_*`:
`WORKSPACE_NAME`, `WORKSPACE_ID`, `WORKSPACE_PATH`, `ROOT_PATH`, `DEFAULT_BRANCH`, `PORT`, `IS_LOCAL`
(`electron/platform/worktreeEnv.cjs`). `PORT` is the first of ten ports reserved for that worktree, from 42000
(`electron/platform/worktreePorts.cjs`); the numbers are not the ones Conductor would have given.

## Files copied into new worktrees

`electron/platform/worktreeCopy.cjs` copies git-ignored files from the checkout into a worktree MoPilot creates or
restores. The patterns are `.worktreeinclude`, else Conductor's `file_include_globs`, else `.env*` where a Conductor
config exists. Only regular files are copied, only inside the worktree, and never over an existing file. The `.env*`
default skips folders git ignores as a whole. Worktrees pinned for main repair get nothing.

## Not carried over

- Conductor Cloud workspaces: transfer them to local in Conductor first. MoPilot hosts no workspaces.
- Conductor's chat history.
- A list of your assigned Linear issues: a chat starts from an issue's key or link instead (docs/start-from-github.md).
