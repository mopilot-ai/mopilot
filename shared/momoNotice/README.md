# MoMo notice pipeline (pure core)

"Notices what matters" for MoMo (design: Function 3 of 5, sections 3.4 and 3.5). Everything here is plain TypeScript with no I/O: the clock, the Google client, the stores and the model are injected. Nothing is wired to a Host, a flag or the UI yet.

```
changeDetect  -> which threads/events changed (no model)
preChecks     -> may only say "quiet"; access-secret mail is private
reading       -> tool-less model, wrapped as data (envelope), strict typed answer
senderCheck   -> before a tell-now about money or credentials
limits        -> quiet hours, daily cap, once per matter, snooze, track, catch-up
brief         -> deterministic morning brief, once-per-day claim
pipeline      -> runNoticePass() ties the stages together and returns decisions
eval/         -> 62 labelled mails, own scenarios, gate, verdict file
```

## What the home lane must implement (`types.d.ts`)

- `GoogleClient`: `listThreads`, `getThreadMeta`, `listEvents`, `calendarEtag` over googleapis with read-only scopes. Return `null` for 404/410; throw on 429/5xx. Mail loaded for reading must carry the topmost `Authentication-Results` header whose authserv-id is `mx.google.com` (several values joined with `\n`) and Gmail label ids.
- `VersionStore` (`get`/`set`) and `NoticeStore` (`getMatter`, `putMatter`, `listMatters`, `tryCountTold`, `claimBrief`). `tryCountTold` and `claimBrief` must be atomic (one transaction); `memoryStore.ts` is the reference behaviour.
- `ReaderModel`: text in, text out, **no tools**. Background model per the design (the home's own Claude or Codex login, cheapest model, low effort).
- `NoticeSettings` (`timeZone` is the HOME's IANA zone and the only zone any day key, quiet-hours test, cap or brief claim uses, so devices in other zones agree; `noticeSettings(zone, changes)` gives the defaults), `CorrespondentHistory` (`knownDomains()`: domains the user has written to or heard from, for the sender check), `Clock` (`now`), a CSPRNG `randomId` (`randomMarkerId` is provided), and the `load(change)` function that fetches the full mail or event for a change.
- Delivery of the outcomes: `tell_now` -> push plus chat line; `hold` -> shown in the next brief (`pendingDelivery`); `catch_up` -> one summary message; `watch` -> a Watching row; `unsorted` -> listed in the brief, no push. After a brief is shown call `markBriefed`.

## Material change, first connect, matters

- **Material change.** A matter already told is told again only when an item makes it more urgent (`urgencyRank` 3 today or final wording, 2 within three days) than the user was told, or names a nearer deadline (`deadlineDay`, a home-local day). A message that only continues the thread is not one. Extracting deadlines is plain code (today, tomorrow, ISO dates, "Nov 27", "by Friday", a few Chinese words), not the model.
- **First connect.** `lastRunAt` undefined means the first pass: nothing is pushed or summarised, tell-nows wait for the brief (`hold`/`first_connect`). The Host must persist `lastRunAt`.
- **Matters.** The key is derived in code (`gmail:<threadId>`, `calendar:<eventId>`). The model may only choose among live matters from the same sender domain that code lists in the prompt; any other key becomes the item's own. A `quiet` answer writes nothing. A reply the user sent (`SENT` label) resolves the matter; `sweepMatters` resolves matters whose event ended or that had no news for 14 days; a later tell-now reopens a resolved matter.
- **Secrets.** Codes and sign-in or reset links are cut out of every prompt (`redactSecrets`). Mail that holds only a secret is quiet and private; mail that also says an account or payment is at risk (security alert, failed payment, paused store) goes to the reading turn with the secret removed.
- **Reason text** from the model is cut to 160 characters, one line, with links, codes and control characters removed.
- **Sender.** Only the topmost `Authentication-Results` counts and it must name `header.from`. A genuine pass from a domain not in `CorrespondentHistory`, or one that imitates a known domain, offers no reply draft for a money or credential ask.
- **Calendar.** The window starts at the home's today (never before the connect day), deleted events are requested, only events updated since the last clean sync are listed, and the probe token and sync time are recorded (`markCalendarSynced`) only when `calendarClean(decisions)`.

## Rules enforced in code

Pre-checks only say quiet and need Gmail's own noise label for list headers. A model failure or unreadable answer is `unsorted`, never a default. The model's answer never overrides quiet hours (default 22:00-08:00), the daily cap (6; brief and catch-up do not count), one nudge per matter (re-nudge only on a material change or after a snooze), or snooze. 

## Sender check (design open item)

Which header: Gmail's own `Authentication-Results` (authserv-id `mx.google.com`) with `dmarc=pass` for the same domain as the `From` line. Anything else (no header, `dmarc=none`, another server's result, a different domain) is not a pass, so MoMo says the sender may not be who it claims and offers no reply draft. `mailauth` (Postal Systems, 8.1.0) is **MIT-licensed** per the npm registry, so OpenClaw's raw-message re-check could be added later; it is not used here because the Gmail API gives us headers, not the raw message, and Gmail's own result is the one that saw the SMTP envelope. Not decided: whether to re-verify DKIM ourselves on the raw `format=raw` message.

## Evaluation

`eval/triage-62.jsonl` holds OpenDuet's 62 invented mails re-labelled to tell_now/track/quiet. `runPreCheckEval` (no model) must silence nothing that matters; `runTriageEval` runs the reading turn; `gate` blocks a change on silenced mail, over-alerts, unsorted items, a lower score or a hard-case regression; `toJsonl` formats every verdict, and `scripts/momo-notice-eval.mjs --out <folder>` writes them (pre-checks and scenarios, no model) and exits 1 when the gate blocks. `eval/scenarios.ts` holds our own end-to-end cases. **Not measured:** no real model has been run on the set; `MODEL_GATE` thresholds are proposals.

## Wiring blockers closed (phase 2, core part)

- **New ask.** A later message that asks something different (`askOf`: a question or request, folded) re-nudges a told matter once (`Matter.notifiedAsk`, `askNudged`). A deadline where none was told is material too. Two escalations give two re-nudges.
- **Duplicate keys.** `parseReading` uses `hasDuplicateKey`, a scanner that reads keys as JSON does (`"verdict"` is `"verdict"`), instead of a pattern.
- **Sender check first.** A tell-now about money, credentials or a risk wording is judged before any limit is applied. If the sender does not pass or is not a known correspondent, the decision carries `suspect: {name}`, the reason and matter title are `This may not be from <name>.`, no reply is offered, nothing from the mail (link, code) is kept, and the brief flags the matter (`BriefMatter.suspect`). It still reaches the owner.
- **Merge candidates** are matters this very thread was already filed under, never matters that only share the sender's domain.
- **The brief cleans** the caller-supplied unsorted titles and errors, and every matter title and summary, again.
- **Model eval.** `scripts/momo-notice-model-eval.mjs` (manual workflow `momo-notice-eval.yml`, secret `MOMO_EVAL_API_KEY`) reads all 91 mails (the 62, our own 5 and 24 synthetic ones in `triage-synth.jsonl`: newsletters, receipts, a person waiting, deadlines, CJK, injected orders) with a real model, writes every verdict and a summary with the silenced-important and over-alert mails, precision and recall per verdict, and token usage, and fails when `MODEL_GATE` is not met. 72 of the 91 mails reach the model (the pre-checks silence the rest), roughly one short prompt each; the summary reports the real input and output tokens, so the cost of a run is read from there, not assumed.
- **Risk wording.** Over the 67 labelled mails, `RISK` matches 8; it sends 3 mails that hold a code or reset link to the model instead of silencing them (the three intended ones: a security alert, a failed payment and a paused store) and none of the 62 OpenDuet mails. No tightening needed on this set; the rate on a real inbox is read from the brief-only week.

## On a Host (phase 2)

`host/src/momoNotice.mjs` is the home lane's implementation of the interfaces above; `host/src/momoServices/notice.mjs` plugs it in by folder.

- **Flag.** `MOMO_NOTICE_MODE` = `off` (default), `brief` (collect, keep matters, the brief and catch-up cards; no tell-now push) or `tell_now` (pushes too). Tell-now pushes stay off until the model eval gate (`scripts/momo-notice-model-eval.mjs`) and a week of brief-only evidence say otherwise.
- **Collector.** The scheduler's tick calls `notice.tick()`; a pass runs at most every 5 minutes (`MOMO_NOTICE_EVERY_MS` overrides, tests set 0), only while this Host is the running home, MoMo is not paused and the lease is current. It reads Gmail and Calendar through the home's Google reader (`home.service('google').reader()`), with the sealed version cursors that service keeps.
- **Stores.** `host/src/momoNoticeStore.mjs` keeps the matters, the day's told count and brief claims (each one atomic `change`), the decision log (500), what could not be sorted, the domains the user writes to, the cards shown and the cursors, sealed under the home's storage, so a move carries them and Reset deletes them.
- **Reading model.** `home.service('notice').setModel(model)` gives the tool-less reader. `createNoticeModel` (`host/src/momoNoticeModel.mjs`) is one over the Host's own harness: a fresh data-only background chat, no approval ever answered, a tool call ends the reading. Until the Host entry gives one, a pass reads nothing and the brief says "No reading model is set up on this machine yet."
- **Daily clock.** `home.daily.setSeams` gets `build` (the deterministic brief from the matters, today's events and the log), `deliver` (the card, the matters it carried marked told, the push), `catchUp` and `claimBrief` (the store's atomic claim). The seam `active` is not given: the Host has no "last active" signal yet, so the day's own gates decide.
- **Push.** Tell-nows go through `home.push.tell({ kind: 'reply', key: 'notice:<change>:<version>' })`, the brief and catch-up as `brief` and `catchUp`. The push's own count and the store's count see the same keys.
- **Apps.** Wire method `host.momoNotice`: `decisions` (the "why you saw this" cards, `MomoDecisionView`), `watching` (Watching rows with `watch`), `cards` (briefs and catch-ups), `state`, `snooze`, `dismiss`.

## Review follow-ups (after #5527)

- **The sender check judges every tell-now and every watched mail.** Money, credentials and risk wording need a passing sender the user already writes to; any other mail is flagged when the check failed or the domain imitates a known one. A suspect mail never renames or rewrites a matter that already exists, and the flag stays only on a matter that mail started: a later genuine update clears it.
- **The brief cleans what it stores** (the name, today's events and places, what could not be checked), not only its text.
- **An ask is not boilerplate.** "Do not reply", unsubscribe and automatic-message lines never count, and an automated sender (no-reply, billing, an Auto-Submitted or List-Unsubscribe header) asks nothing, so they cannot spend the one re-nudge.
- **Still open:** the model eval calls the Messages API with an API key (`MOMO_EVAL_API_KEY`); it has never run, so `MODEL_GATE` is unvalidated and tell-now stays off. The `RISK` measurement used invented mail and needs the owner's own labelled sample.
