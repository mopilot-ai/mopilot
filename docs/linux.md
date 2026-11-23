# Linux desktop builds

MoPilot's Linux desktop uses the same Electron UI, main-process chat services and Codex, Claude Code and ACP adapters as macOS. Linux desktop computer control is separate work. Browser tools and coding tools remain available independently of that capability.

Build on a native Linux x64 or ARM64 machine. The initial validation target is Ubuntu 24.04, with a graphical desktop and a Secret Service or KWallet keyring. Other distributions and Wayland need separate validation; the CI journey uses X11. Install Node.js 24, npm, the Rust toolchain pinned in `core/rust-toolchain.toml`, Python 3 and a C/C++ build toolchain. GTK 3, NSS, ALSA, libsecret and `iproute2` are runtime dependencies; `ss` from `iproute2` supports authenticated local tool connections when the Rust peer-credential check is unavailable.

```sh
npm ci
npm run package:linux
```

The build creates `out/MoPilot-linux-<arch>` and two distribution files in `out`: `MoPilot-<version>-<arch>.deb` and `.tar.gz`. `npm run package:linux:dir` builds only the app folder. Linux builds refuse to run on a macOS host. The terminal addon is rebuilt against the packaged Electron ABI in the staging directory, without changing the checkout's installed dependencies.

Install the `.deb` with the distribution's software installer. The tar archive contains the app folder for manual installations; configure desktop integration yourself and use a distribution that permits Chromium user namespaces. The Debian package registers the `mopilot:` URL scheme for browser sign-in callbacks. A desktop keyring must be running and unlocked to save credentials. MoPilot refuses secret writes when Electron selects its `basic_text` fallback; it preserves existing encrypted files and reports the failed save.

The package includes the Rust MCP bridge, `sage-mcp` (`core/crates/sage-mcp`), beside the Rust core in `resources/core`, built for the same glibc floor. Codex and ACP agents start it to connect to the shared tool registry over MoPilot's Unix tool socket, without macOS Swift helpers, a Node runtime or Electron's disabled RunAsNode mode. The package build stops if the bridge is missing. A Linux checkout runs the portable bridge, `host/bin/sage-mcp.mjs`, under the login `PATH`'s Node, with the checkout's core. Claude Code continues to use its existing shared MCP channel. Sessions retain independent tokens, process identity checks and approvals.

Linux keeps Electron's sandbox and all applicable production fuses. Embedded ASAR integrity validation is disabled only on Linux because Electron implements that fuse on macOS and Windows. This is distinct from the Rust addon's recorded SHA-256 verification, which remains enabled.

The release recipe builds and installs each architecture on its own GitHub-hosted Linux runner with scratch user data and a temporary desktop keyring. It starts the installed package under the runner's default sandbox policy and runs `node tests/packaged/linux-desktop.mjs <installed-mopilot-executable>`. That check uses isolated fake agents and a local npm registry to exercise registry installation, authentication, MCP tools, approvals, Stop, terminal execution, browser navigation, mixed harness sessions and restart persistence. It also requires encrypted account files from the real keyring; it does not validate a provider's live account login. Run it only on CI or an isolated Linux VM, with an unlocked keyring and graphical display, never on the user's desktop. Its results and screenshot go to `test-results/linux-package`.

Uploads wait for the release's required checks. The update feed and download page serve the `.deb`, with the tar archive offered as an alternative; updates open a download and leave current chats running. Both artifacts are retained in the release. Publishing a release remains a separate action.

