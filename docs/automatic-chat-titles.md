# Automatic chat titles

After the first message of a new, saved chat is successfully sent, the sidebar shows a compact title made from that prompt immediately. A helper generates a short, descriptive title in the prompt's language in the background. Follow-ups never change the title or wait for this helper.

Codex uses its existing ephemeral helper thread with a 30-second turn timeout. Claude uses its existing unpersisted Haiku query with the chat's own account, no tools, and no project settings. The helper's output stays out of the conversation and chat history. These requests use the provider's normal model quota or billing.

Generated output is normalized through `shared/title.mjs`: strip surrounding Markdown and quotation marks, take the first nonempty line, and truncate unusually long output. Empty output or generation errors use the provisional title. A title is published only after its native save succeeds. Users can rename a chat through the existing rename action; an in-flight helper respects that name, including its error fallback.

Only the new chat's first native session is titled. Resumed Claude sessions, forks, temporary chats, and later harness segments keep their names. Claude tracks helpers in flight to prevent duplicate requests. ACP harnesses retain their existing first-prompt provisional names because they have no separate title-generation API.

Regression coverage: `tests/title.test.ts`, `tests/claude.test.ts`, and `tests/codexAdapter.test.ts` cover normalization, first-prompt selection, follow-ups, manual rename races, and generation/save failures.
