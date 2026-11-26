// swift-tools-version:5.9
// Builds the macOS bundle updater that stages and activates a signed MoPilot release.
import PackageDescription

let package = Package(
    name: "UpdateInstall",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "update-install"),
        .testTarget(name: "UpdateInstallTests", dependencies: ["update-install"]),
    ]
)
