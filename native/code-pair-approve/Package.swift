// swift-tools-version:5.9
// code-pair-approve: the person's own proof that another Mac may control this one (Remote Run pairing by code, #5576).
// It holds a P-256 key (Secure Enclave, or the keychain where there is none: `weak`) usable only after the system's
// own prompt (Touch ID or the password), and signs only the approval text it builds itself from the Host's fields.
// Built by scripts/build-code-pair-approve.mjs.
import PackageDescription

let package = Package(
    name: "CodePairApprove",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "CodePairApproveCore"),
        .executableTarget(name: "code-pair-approve", dependencies: ["CodePairApproveCore"]),
        .testTarget(name: "CodePairApproveCoreTests", dependencies: ["CodePairApproveCore"]),
    ]
)
