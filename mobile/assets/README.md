# Phone app images

Every image here is generated from the desktop icon (`build/icon.png`) by `npm run icons`, which also writes `../store/graphics/`. They are **placeholders**: the real brand artwork replaces them by replacing `build/icon.png` (or by editing the generator) and running the script; `tests/phoneBranding.test.ts` and `tests/phoneRelease.test.ts` fail while the committed files differ from the generator's output, and check the sizes below.

| File | Used for | Size | Notes |
| --- | --- | --- | --- |
| `icon.png` | iOS app icon, App Store icon | 1024x1024 | opaque, no alpha, no rounded corners (iOS rounds it) |
| `adaptive-foreground.png` | Android adaptive icon foreground | 1024x1024 | transparent; glyph inside the 66dp-of-108dp safe circle |
| `adaptive-monochrome.png` | Android 13 themed icon | 1024x1024 | white glyph on transparency |
| `splash-icon.png` | splash screen (`app.json` `splash`) | 1024x1024 | glyph on transparency over `#1f1f1f`; shown contained |
| `notification-icon.png` | Android notification small icon | 96x96 | white on transparency |
| `favicon.png` | web | 48x48 | |
| `../store/graphics/play-store-icon.png` | Play listing icon | 512x512 | opaque, full square, no pre-rounded corners |
| `../store/graphics/play-feature-graphic.png` | Play listing feature graphic | 1024x500 | |

## Still to create by hand (screenshots need the real UI)

- **App Store** screenshots for the iPhone sizes Apple requires (the app is iPhone only: `ios.supportsTablet` is `false`, so no iPad screenshots are asked for): the largest class App Store Connect requires: 6.9" at 1320x2868, 1290x2796 or 1260x2736, or 6.5" at 1284x2778 or 1242x2688 (smaller classes are scaled from these); 1 to 10 each, PNG or JPEG, no transparency. Take them with `npm run screenshots` (`docs/mobile-remote/release-checklist.md`, section C3) from a device showing the dev host's seeded chats, after the phone UI work is final.
- **Google Play** phone screenshots: 2 to 8, 16:9 to 9:16, each side 320 to 3840 px (1080x1920 recommended); optional 7" and 10" tablet shots.
- Optional App Store app preview video (15 to 30 s).
