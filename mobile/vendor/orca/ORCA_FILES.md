# Files copied from Orca

Every file under `mobile/vendor/orca/` except the three documents (`README.md`, `LICENSE-ORCA.md`, this file) has exactly one row. Add the row in the same commit that adds the file; `tests/phoneVendorGuard.invariant.test.ts` fails otherwise.

| Column | Meaning |
|---|---|
| Path | Path of the copy, relative to `mobile/vendor/orca/`, in backticks |
| Orca path | Path in the Orca repository, relative to its root, in backticks |
| Orca commit | The 40-character commit the file was copied from |
| Orca blob | The 40-character git blob id of the file at that commit (so a diff against Orca is one command) |
| Changes | What we changed: `renamed`, `imports cut`, or a short phrase. Empty is not allowed |
| Licence | `MIT (Lovecast Inc.)`, or the licence of the file when it differs |

Orca commit read by the study: `fe8a4a4ae6f7c01907e270e58c5fdb4423936a5d` (2026-11-14).

<!-- orca-files:start -->
| Path | Orca path | Orca commit | Orca blob | Changes | Licence |
|---|---|---|---|---|---|
| `i18n/pluralFamily.ts` | `src/shared/i18n-plural-family.ts` | fe8a4a4ae6f7c01907e270e58c5fdb4423936a5d | 0d58138670c319d426bbbbd06e070cf5e1e92adb | renamed; only `resolvePluralFamilyKey` kept; import of its shared helper cut | MIT (Lovecast Inc.) |
| `i18n/pseudoLocalization.ts` | `src/shared/pseudo-localization.ts` | fe8a4a4ae6f7c01907e270e58c5fdb4423936a5d | 9019f1731683b7e93da6be13d4729fd1ca0fc34b | renamed; only `pseudoLocalizeString` kept; locale constants cut | MIT (Lovecast Inc.) |
| `i18n/mobileI18n.ts` | `mobile/src/i18n/mobile-i18n.ts` | fe8a4a4ae6f7c01907e270e58c5fdb4423936a5d | d3a5b94be34773101a6f087a0a12fb7fc3ac69e4 | renamed; made a factory; shared locale type, runtime subset and catalog imports cut; keyed calls with no inline fallback; missing-key hook | MIT (Lovecast Inc.) |
| `support/redactLog.ts` | `mobile/src/diagnostics/connection-log-redaction.ts` | fe8a4a4ae6f7c01907e270e58c5fdb4423936a5d | 22869923ea4a1ba4a6987ca3c347f82fc317a2a9 | imports cut: entry type made local and generic; header added | MIT (Lovecast Inc.) |
| `support/LogRows.tsx` | `mobile/src/components/host-connection/ConnectionLog.tsx` | fe8a4a4ae6f7c01907e270e58c5fdb4423936a5d | 6e7aa18bdeab542e70635ea7a06589dfd29a04f3 | rows only; theme, store and scroll cut; colours and base time as props | MIT (Lovecast Inc.) |
| `ds/metrics.ts` | `mobile/src/theme/mobile-theme.ts` | fe8a4a4ae6f7c01907e270e58c5fdb4423936a5d | 3d51be01e1ea467cee4744da65a5bb310bf5ff7c | extracted spacing, radii, concentricRadius and feedback; colours, scheme store and typography dropped; renamed header | MIT (Lovecast Inc.) |
| `ds/Switch.tsx` | `mobile/src/components/controls/MobileSwitch.tsx` | fe8a4a4ae6f7c01907e270e58c5fdb4423936a5d | 371b7d4832116757e7ebc60278570e1a01deba94 | renamed MobileSwitch to Switch; imports cut to the MoPilot design system (tokens, haptic); reduced-motion hook that follows the system setting live; themed stylesheet inlined | MIT (Lovecast Inc.) |
<!-- orca-files:end -->
