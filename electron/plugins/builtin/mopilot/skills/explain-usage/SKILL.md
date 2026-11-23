---
name: explain-usage
description: Use when the user asks about their usage, limits, quota, rate limits, context window, token use or cost in MoPilot, or why a chat hit a limit. Explains what the numbers mean and how to reduce usage, using the data MoPilot already shows.
---

# Explain usage

Answer from real numbers, not from memory. MoPilot already collects them.

## Where the numbers are

- **`/status`** in the composer shows the session's configuration and usage for the chat's harness: the context window use and, where the harness reports it, the usage windows (for example the 5-hour and weekly limits) with how much is used and when each resets.
- The usage ring beside the composer’s model picker opens the chat’s context usage and the serving account’s plan windows with their reset times. **View context** opens the context breakdown. **All usage** opens the side pane’s Usage tab when plan windows are available.
- The side pane's **Usage** tab lists **Plan limits** for every signed-in Claude Code and Codex login, each window with its reset, before the chat's own context and token totals.
- The account menu and Settings show usage bars per signed-in account when the harness reports them.
- Claude Code also answers `/context` (what fills the context window) and `/usage` in its own terms.
- Codex reports account rate limits through its own status. MoPilot shows them in the same places.

Ask the user to run `/status` and paste or describe what they see if you cannot see it yourself. Do not make up limits, prices or reset times. If a number is not available, say so.

## How to explain

1. Separate three different things:
   - **Context window**: how much of this conversation fits in the model's memory right now. It fills as the chat grows; compacting or starting a new chat frees it.
   - **Usage limits**: the plan's allowance over a time window (short windows and a weekly one). They are shared across the account's chats and tools.
   - **Cost**: only relevant for API-key use, where each token is billed.
2. Say which of these the user's question is about, then read the relevant number and what it means in plain words ("about 70% of the 5-hour window used; it resets at 3:40 pm").
3. If a chat hit a limit, say which one, when it resets, and the options: wait, switch account if the user has more than one signed in, or switch to a smaller model or lower effort.

## What drives usage

Long conversations (every turn re-reads the context), large files and tool outputs pasted into the chat, many parallel sub-agents, high effort or the largest model, and long-running loops. Keep suggestions concrete and few:

- Start a new chat for a new task, or compact a long one.
- Point at files instead of pasting them; ask for narrower searches.
- Use a smaller model or lower effort for simple work.
- Stop background work you no longer need.

Keep the answer short: the number, what it means, one or two things they can do.
