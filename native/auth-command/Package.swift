// swift-tools-version:5.9
// auth-command: the key helper Codex runs as a model provider's auth.command. It reads one key from the
// login keychain and prints it, without ever showing a dialog. Built by scripts/build-auth-command.mjs.
import PackageDescription

let package = Package(
    name: "AuthCommand",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "auth-command"),
    ]
)
