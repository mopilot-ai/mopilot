# Chrome side panel: design

Design and surface matrix for MoPilot's Chrome extension side panel (`electron/chrome-extension/`). The baseline it started from is [mopilot-inventory.md](mopilot-inventory.md). Tracked in #3046.

## 1. Sources of values

The panel's values are MoPilot's own: colours come from the app's palette (`src/styles/tokens.css`, `shared/defaultPalette.mjs`), and sizes, motion and wording are decisions written down here and in the code comments. Other products' panels are used the way a user sees them, for what a surface should do. Their code, tokens and strings are not a source.

## 2. Principles

1. **One state, one meaning.** A turn that stopped or failed is not "Done". Every progress state the panel can show has its own wording and dot.
2. **Say what happened where the user looks.** Limits, errors and hand-offs appear in the thread or above the composer, never only in a collapsed row or the chat title.
3. **Motion shows change.** Steps enter, a step's state cross-fades, the working label shimmers and banners slide in. Every animation respects `prefers-reduced-motion`.
4. **Harness-neutral.** Every change lives in the shared panel and main-side rows code, so Codex, Claude Code and ACP chats behave the same. A harness without a field (for example a turn duration) falls back to the old behavior.
5. **Each batch is verified in real Chrome** with a spec that measures or reads the real panel (the `cuj-chrome-panel-*` pattern); unit tests pin the logic. Both are named in the PR, with what was not shown.

## 3. Surface matrix

| # | Surface | MoPilot | Status |
|---|---|---|---|
| 1 | Message box | no handle, grows; radius 16 | done (#3152) |
| 2 | Toolbar | a 1px hairline under it | done (B1, #3313) |
| 3 | Menus (model, permission, +) | close on Esc and on a press outside, as well as by a second click or a pick | done (B1, #3313) |
| 4 | Send button | 28x28 r8, always drawn, 50% when disabled | done (B1, #3313) |
| 5 | Progress line | "Stopped" and "Failed" from the turn's status, "Limit reached" | done (B2, #3316) |
| 6 | "Watching Ns" | counts from the turn's own start when MoPilot can say it | done (B2, #3316) |
| 7 | Step rows | "Worked for" fold (#3159); running / done / failed wording, last three steps while running, shimmer, enter and cross-fade motion, check at the end | done (B3, #3346) |
| 8 | Assistant text | a serif 14/26.4; Markdown while streaming; headings (h1 20px, h2 17px, then body size), nested lists, quotes, images (data: at once, https: after a click) | done (B4) |
| 9 | Answer actions | Copy and Retry (sends the message again, only while idle); no thumbs (no backend) | done (B4) |
| 10 | Plan approval | the card draws the plan (Markdown, folded past 12 lines) | done (B5) |
| 11 | Approval cards | "MoPilot needs your OK", Allow once / Decline / Always allow on this site, Enter / Esc / Cmd+Enter, a reminder that MoPilot asks before buying, creating accounts or getting past a CAPTCHA (site cards) | done (B5) |
| 12 | Banners above composer | error banner with Retry (only for a lost connection) and a dismiss X, 0.15 s enter/exit, one banner at a time; the refusal card above the usage banner | done (B6, #3320; B9) |
| 13 | Limit | limit note in the thread; a "5-hour / Weekly limit almost used up" info banner with a dismiss X | done (B9) for Claude Code and Codex; a basic (ACP) harness has no usage-window signal, so it shows none |
| 14 | Tab group | named for the chat; ⌛ 🔔 ✅; "MoPilot" without a title | done (#3073) |
| 15 | Page indicator | pill, glow, favicon mark | decision: keep ours; the frame colour stays our accent |
| 16 | "Act without asking" | "Full access" pill, no frame | decision open: not drawn (Full access is the default, so a frame would show on every new panel) |
| 17 | Sign-in / hand-off | cards exist | later, no gap found |
| 18 | Empty state | the greeting, "Use / for commands" and "Type @ to mention a tab or chat" cycling every 3 s over the empty box (0.2 s fade, none under reduced motion), a larger mark | done (B7, #3376) |
| 19 | Dark mode | the app's dark palette (section 6) | done (B8) |

## 4. Batches

Each batch is its own pull request, independent files where possible so they land in parallel. Every batch states its real-Chrome spec.

- **B1 Header and composer.** Toolbar bottom hairline (`1px solid var(--line)`); menus close on Esc and outside click; send disabled at 50%. Spec: measure the hairline, open a menu and press Esc.
- **B2 Truthful progress.** Distinct lines for stopped ("Stopped") and failed ("Failed") turns from the turn's status; "Watching Ns" counted from the turn's own start. Main sends the status with the rows read. Spec: stop a turn from the panel and read the line.
- **B3 Work timeline.** Running / done / failed wording per step, the last three steps visible while running, shimmer on the working label, enter and status cross-fade motion, check-circle at the end; `prefers-reduced-motion` respected. Spec: a multi-step task; read labels and the visible count.
- **B4 Assistant rendering.** Markdown rendered while streaming, headings sized, nested lists, blockquotes, images; a Retry action beside Copy. Spec: a reply with each element; measure heading sizes.
- **B5 Plan and approvals.** The plan card draws the plan text; the site card's wording and shortcuts. Spec: a plan-approval turn in the fake harness; read the plan text and the buttons.
- **B6 Banners.** An error banner above the composer with Retry, a refusal card, 0.15 s enter/exit. Spec: a failed turn in the fake harness; read the banner and press Retry.

Landed in main: B1 #3313, B2 #3316, B4 #3315, B5 #3318, B6 #3320, B3 #3346, B8 dark mode #3366, B7 empty state #3376, B9 refusal card and approaching banner #3379. Still open: the Full access frame (row 16, a decision).

B3 status: step lines read in three states (running, done, failed), the run at the end of the thread shows its last three steps while the turn runs or waits, the working line and a running step shimmer (3 s), new steps enter (430 ms) and a step that changes state fades its new line in (0.25 s; the old row is replaced in one frame), a finished turn ends in a muted check circle, and none of the motion draws under `prefers-reduced-motion`.

B9 status (refusal card and "approaching"): each harness's own words become one shape in main (`shared/chatSignals.mjs`). A refusal is a `refusal` note in the chat's history (Claude Code: the assistant frame with stop reason `refusal`, or the `model_refusal_no_fallback` notice, one card for both, retracted by `model_refusal_fallback`; Codex: a turn error `cyberPolicy` or `misalignmentPolicyViolation`; ACP: stop reason `refusal`), shown as the panel's "Stopped by a safety check" card while it is the last row of an idle chat. A usage warning is `limitWarning {kind, window, resetsAt, utilization}` on the chat's read: Claude Code's `rate_limit_event` with `allowed_warning`, kept in memory per chat and per window (cleared by its own window's `allowed` or `rejected` event or its reset, not by an idle session closing, lost on an app restart until the CLI reports again); Codex's windows of the login that serves the chat, from the account pool (`servingLogin`: the relay's pin, or the login the app-server holds, none while that moves or cannot be told), from 75% used (`CODEX_WARN_AT`); ACP: none, because its protocol carries no usage field. Overage has no window to warn about, so it has no banner. Priority: error, refusal, usage, tab note. Dismissals are kept per chat and banner key. The composer stays open under both. The usage banner's "limit reached" state is fed by `limit {key, window, resetsAt}` on the chat's read, set while the chat is idle after a turn that ended on its harness's usage limit (every harness reports it through `ChatController.onLimit`: Claude Code's rejected rate limit with no login to move to, Codex's `usageLimitExceeded`, a basic harness's rate-limit error) and cleared by the next send or the next turn that ends; the window and reset come from Claude Code's rejected `rate_limit_event` and from Codex's used-up window of the serving login, a basic harness names neither, and a limit note that ends the rows says it after a restart. The panel words it "5-hour limit reached · resets 3:00 PM", "Weekly limit reached · resets Tuesday 3:00 PM", else "Usage limit reached"; the note row keeps the harness's own message. The composer stays open under it, so the chat may go on another harness or after the reset.

Not planned until asked: a header with title and Share, thumbs, a voice button. They need either a backend we do not have or a design decision the user should make.

## 5. Unknowns to close as we go

- Whether `turn.status` carries "interrupted" and "failed" on every harness's history (B2 checks Claude, Codex and ACP translators first).

## 6. Dark mode (B8)

The side panel keeps every colour in a token: light in `sidepanel.css` `:root`, dark in its `prefers-color-scheme: dark` block, on `panel.css`'s base tokens. `tests/chromePanelDarkTokens.invariant.test.ts` fails on a colour literal outside a `:root` block and on a light colour token with no dark value; `tests/chromePanelDarkTheme.test.ts` pins the values below, the elements that read them and the contrast of each text and mark on its surface (4.5:1 for text, 3:1 for marks). The values come from the app's own dark palette (`src/styles/tokens.css`).

| Surface | Token | Dark value | From |
|---|---|---|---|
| Page, sidebar | `--bg` | `#171a21` | the app's main surface |
| Text | `--fg` | `#eef1f6` | the app's text |
| Muted text, icons, placeholder, check circle | `--muted` | `#a0a0a0` | panel.css's own dark muted grey |
| Hairlines, card and blockquote borders | `--line` | white at .1 | the app's hairline |
| Menu and choice-button borders | `--line-strong` | white at .2 | the app's strong hairline |
| Composer card, jump button, table header fill | `--card`, `--soft` | `#22252c` | the app's raised surface |
| Menus | `--menu-bg`, `--shadow-*menu` | `#22252c`, `0 8px 24px rgb(0 0 0 / 0.32), 0 2px 6px rgb(0 0 0 / 0.2)` | the app's menu and its shadow |
| User bubble, usage banner, code block | `--bubble`, `--info-bg`, `--code-bg` | `#22252c` | the app's bubble and code block |
| Hover fill (menus, rows, icons) | `--hover` | `#35383f` | the app's third surface: a step above the menus and the card, so it shows on them |
| Inline code | `--code-ic-bg`, `--code-ic-fg` | white at .06, the text colour | as in light |
| Links | `--link` | the text colour (underlined) | as in light |
| Error banner | `--danger-bg`, `--danger-fg` | `#361f1e`, `#f06a62` | the app's red at 16% over the page, and its red text |
| Error text, failed step dot, popup error | `--error` | `#f06a62` | the app's red text |
| Send button, primary button | `--btn`, `--btn-fg` | `#ececec`, `#202124` | decision: neutral inverse in both schemes, as in light |
| Accent | `--accent` | `#3b6ff5` | the app's blue accent, in both schemes |
| Dots, notice border, checkbox accent | `--ok`, `--wait`, `--off` | unchanged | each is 3.6:1 or better on the page |

Light uses the app's light palette (`--bg` `#fbfcfe`, `--fg` `#181e2a`, `--soft` `#f0f1f3`, the danger pair `#f9edeb` / `#c9332a`) with the panel's own greys (`--muted` `#6b6b6b`, `--line` `#e4e4e4`). Not dark-specific: no border on code blocks and inline code, tables keep full-width cell borders and a filled header, links stay the text colour, and an exceeded usage limit is neutral, not danger.
