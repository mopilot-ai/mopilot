// swift-tools-version:5.9
// MoPilot.app: the helper that owns the Accessibility and Screen Recording grants.
// HelperCore is the pure policy (deny-list, peer check, input classification, sizing); the executable
// wires it to ScreenCaptureKit, AXUIElement, CGEvent and a unix socket. Built by scripts/build-helper.mjs.
import PackageDescription

let package = Package(
    name: "ComputerUseHelper",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "HelperCore"),
        .executableTarget(name: "ComputerUseHelper", dependencies: ["HelperCore"]),
        .testTarget(name: "HelperCoreTests", dependencies: ["HelperCore"]),
    ]
)
