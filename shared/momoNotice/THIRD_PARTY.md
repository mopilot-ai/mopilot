# Third-party code and data in `shared/momoNotice`

Full licence texts are in `docs/licenses/` and ship in `build/THIRD_PARTY_NOTICES.md` (feature file `scripts/third-party/momo-notice.json`).

| File here | From | Licence | What we did |
| --- | --- | --- | --- |
| `preChecks.ts` (bulk, category, auto-reply, calendar-response rules) | OpenDuet `openbot/server/src/openduet/triage.ts` | MIT, Copyright (c) 2026 CopilotKit (`docs/licenses/openduet-LICENSE.txt`) | Vendored with the same rules and comments; `labels` replaces `gmail_labels`; rules return a private flag too. |
| `reading.ts` (two-class prompt wording, answer parsing idea) | OpenDuet `triage.ts` | MIT, CopilotKit | Reworded for three outcomes (`track` is ours); parser rewritten without zod and made strict. |
| `brief.ts` (sections, 50-mail cap that is said out loud) | OpenDuet `openduet/brief.ts` | MIT, CopilotKit | Structure only; no code copied. |
| `eval/triage-62.jsonl`, `eval/triageEval.ts` | OpenDuet `evals/triage/emails.jsonl`, `run.ts` | MIT, CopilotKit | 62 invented mails re-labelled to tell_now / track / quiet (22 / 6 / 34) by us. |
| `envelope.ts` | OpenClaw `src/security/external-content.ts` | MIT, Copyright (c) 2026 OpenClaw Foundation (`docs/licenses/openclaw-LICENSE.txt`) | Vendored and trimmed: injected id source, no web/webhook helpers, no overlap check (the two marker patterns cannot overlap). |
| `senderCheck.ts` | OpenClaw `extensions/imap/src/sender-gate.ts` | MIT, OpenClaw Foundation | Ported the Authentication-Results parser and the trusted-authserv-id DMARC rule; the `mailauth` re-check is left out (see README). |
| `changeDetect.ts` | n8n nod `src/providers/composio/activity.ts` | Apache-2.0, Copyright 2026 n8n GmbH (`docs/licenses/nod-LICENSE.txt`, `nod-NOTICE.txt`) | Ported the thread-version hash, the draft/spam/trash filter and the etag-plus-day probe. **Changed:** the Composio proxy and zod are replaced by an injected `GoogleClient`; the full-body read and read-stability recheck are not ported. |
| `preChecks.ts` (`holdsAccessSecret`) | n8n nod `src/server/mail-check.ts` | Apache-2.0, n8n GmbH | Only the definition of an access secret (codes, magic links, reset links) is reused; nod asks a model, we use patterns. |
| `limits.ts` (wrap-around quiet window) | gbrain `src/core/minions/quiet-hours.ts` | MIT, Copyright (c) 2026 Garry Tan | Pattern only; the code is our own and uses `Intl` with the home's time zone. No licence text is shipped because no code is copied. |

Nothing here comes from an AGPL or GPL project.
