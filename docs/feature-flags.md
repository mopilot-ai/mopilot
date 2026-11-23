# Feature flags

Every flag is defined once, in `shared/flagDefs.mjs`: its key, build default, owner, removal date (or `permanent`),
description and remote mode. The desktop's defaults (`electron/platform/flags.cjs`) and the server's key list
(`web/lib/flags.ts`) are read from it, and the renderer reads the values main resolved.

- `kill`: the server can only turn the flag off (`/api/flags`), as the switches that guard shipped features do. These
  are usually `permanent`.
- `toggle`: a feature still in development. It needs a removal date; the server turning one on per channel comes later.

`tests/flagExpiry.invariant.test.ts` fails, naming the key and owner, for a flag with no owner, a dated flag with no
date, or one past its removal date. A flag may live through its removal date itself.

## Flags for trunk-based development

Unfinished work merges to main behind a `toggle` flag that ships off, with an owner and a removal date a few weeks out.
Remove the flag (and the off path) once the feature ships, before that date.

In an unpackaged build, `MOPILOT_FLAGS=@dev` turns on every `toggle` flag not past its removal date; a packaged build
ignores `MOPILOT_FLAGS`. A key named beside it wins: `@dev,x=0` keeps `x` off. The E2E fixtures launch with `@dev`
(`tests/e2e/fixtures/devFlags.ts`), so a flagged feature is tested with its flag on from its first pull request. A
spec pins a flag off with `test.use({ env: { MOPILOT_FLAGS: 'x=0' } })`, or passes `{}` for no override at all.
