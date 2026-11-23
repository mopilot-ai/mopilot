// swift-tools-version:5.9
// disclaim: a launcher that replaces itself with a command whose TCC "responsible process" is the command
// itself, not MoPilot. Agents and shells started through it don't inherit MoPilot's microphone,
// Automation or file grants. Built by scripts/build-disclaim.mjs.
import PackageDescription

let package = Package(
    name: "Disclaim",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "disclaim"),
    ]
)
