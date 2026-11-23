// swift-tools-version:5.9
// sage-mcp: the stdio MCP server a harness launches to reach MoPilot's tools. It answers the MCP
// handshake itself and forwards tools/list and tools/call to main over a unix socket. A native binary,
// because MoPilot's own Electron binary can't run as node (RunAsNode is fused off).
// Built by scripts/build-sage-mcp.mjs.
import PackageDescription

let package = Package(
    name: "SageMCP",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "sage-mcp"),
    ]
)
