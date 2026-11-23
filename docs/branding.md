# MoPilot naming and compatibility

The desktop app is **MoPilot**. Its npm package is `mopilot`, the website package is `mopilot-web`,
the macOS bundle is `MoPilot.app`, the Windows executable is `MoPilot.exe`, and the Linux executable
is `mopilot`. New release artifacts start with `MoPilot-`.

Some identifiers retain their earlier spelling because existing installations or services own them:

- The profile folder remains `MoPilot Code` under Electron's application-data directory. Environment
  overrides still take precedence. Renaming the display name never moves an existing profile.
- Before Electron is ready, the app uses the stable storage name to configure macOS Keychain and Linux
  keyring encryption. After readiness, it sets the display name to MoPilot before opening windows.
  Electron 44.7.0 captures the encryption name in
  [`PostCreateMainMessageLoop`](https://github.com/electron/electron/blob/v44.7.0/shell/browser/electron_browser_main_parts.cc).
  Preserve this ordering when updating Electron; cookies, account credentials and saved browser logins
  depend on it.
- Bundle IDs, keychain groups, Windows installer identity and the Debian package name stay stable.
  Existing `MoPilot Code Dev` signing certificates remain preferred; `MoPilot Dev` is also supported.
- Stripe's `metadata.app` and customer idempotency prefix remain `mopilot-code`, keeping in-flight
  payments and the other application's webhook routing intact. Customer-facing credit names use MoPilot.
- The existing `mopilot-ai/mopilot-code-release` repository, storage bucket, server directories and Docker
  Compose project retain their provisioned names.

The release upload endpoint accepts both artifact prefixes. The signed-update check tries the new
filename first and retries the earlier filename only for HTTP 404; it also recognizes both bundle names.
Published download records keep their recorded URLs.
