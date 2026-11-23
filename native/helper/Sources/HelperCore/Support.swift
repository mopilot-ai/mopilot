import Foundation

// MARK: - Launch config

/// Written by main (0600, in a 0700 directory) and passed as `--launch <path>`; read once and deleted,
/// so the token never appears in argv.
public struct LaunchConfig: Codable, Equatable {
    public let socket: String
    public let token: String
    public let mainPid: Int32
    public var denyBundleIds: [String]?

    public init(socket: String, token: String, mainPid: Int32, denyBundleIds: [String]? = nil) {
        self.socket = socket
        self.token = token
        self.mainPid = mainPid
        self.denyBundleIds = denyBundleIds
    }

    public enum Invalid: Error, Equatable {
        case reason(String)
    }

    public static func parse(_ data: Data) throws -> LaunchConfig {
        let c = try JSONDecoder().decode(LaunchConfig.self, from: data)
        guard c.socket.hasPrefix("/") else { throw Invalid.reason("socket must be an absolute path") }
        // sockaddr_un.sun_path is 104 bytes including the NUL.
        guard c.socket.utf8.count < 104 else { throw Invalid.reason("socket path too long") }
        guard c.token.count >= 32 else { throw Invalid.reason("token too short") }
        guard c.mainPid > 1 else { throw Invalid.reason("bad main pid") }
        return c
    }

    public static func load(path: String) throws -> LaunchConfig {
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        try? FileManager.default.removeItem(atPath: path)
        return try parse(data)
    }
}

// MARK: - Screenshot size

/// Pixel size for a capture of a display `w`×`h` points at `scale` pixels per point, with the longest
/// side at most `maxSide` pixels (never upscaled).
/// `maxPixels`, when given, also caps the pixel count (width × height).
public func captureSize(widthPoints w: Double, heightPoints h: Double, scale: Double, maxSide: Int = 2000, maxPixels: Int? = nil) -> (width: Int, height: Int) {
    let pw = max(1, w * max(scale, 1)), ph = max(1, h * max(scale, 1))
    var k = min(1, Double(max(maxSide, 1)) / max(pw, ph))
    if let maxPixels, maxPixels > 0 { k = min(k, (Double(maxPixels) / (pw * ph)).squareRoot()) }
    return (max(1, Int((pw * k).rounded())), max(1, Int((ph * k).rounded())))
}

// MARK: - Permissions

public enum Permission: String, CaseIterable {
    case accessibility
    case screenRecording
    case inputMonitoring

    /// The Privacy & Security pane that lists this permission.
    public var settingsURL: String {
        let anchor: String
        switch self {
        case .accessibility: anchor = "Privacy_Accessibility"
        case .screenRecording: anchor = "Privacy_ScreenCapture"
        case .inputMonitoring: anchor = "Privacy_ListenEvent"
        }
        return "x-apple.systempreferences:com.apple.preference.security?\(anchor)"
    }
}

// MARK: - Errors

/// JSON-RPC error codes the helper returns; `reason` is a stable string main can switch on.
public struct HelperError: Error, Equatable {
    public let code: Int
    public let reason: String
    public let message: String

    public init(_ code: Int, _ reason: String, _ message: String) {
        self.code = code
        self.reason = reason
        self.message = message
    }

    public static func invalidParams(_ m: String) -> HelperError { HelperError(-32602, "invalid_params", m) }
    public static func methodNotFound(_ m: String) -> HelperError { HelperError(-32601, "method_not_found", "unknown method \(m)") }
    public static func permission(_ p: Permission) -> HelperError { HelperError(1, "permission_denied", "\(p.rawValue) permission not granted") }
    public static func refused(_ why: String) -> HelperError { HelperError(2, "target_refused", "refused: target is \(why)") }
    public static let notControlling = HelperError(3, "not_controlling", "acquire control first")
    public static func paused(_ r: PauseReason) -> HelperError { HelperError(4, "paused", "paused by the user (\(r.rawValue)); resume first") }
    public static func lockBusy(_ holder: String) -> HelperError { HelperError(5, "lock_busy", "the desktop is in use by \(holder)") }
    public static let aborted = HelperError(6, "aborted", "aborted by the user")
    public static let unauthorized = HelperError(7, "unauthorized", "unauthorized")
    /// A request of a turn main revoked (it ended or was stopped): main reads it as a stop, like `aborted`.
    public static let staleTurn = HelperError(6, "aborted", "Stopped: the turn this request belongs to ended or was stopped")
}

// MARK: - Desktop lock

/// One controller per user at a time, across every helper instance (each MoPilot profile launches
/// its own). An flock on a per-user file: it is released when the holder exits, even on a crash.
public final class DesktopLock {
    public let path: String
    private var fd: Int32 = -1

    public init(path: String) {
        self.path = path
    }

    deinit { release() }

    public var isHeld: Bool { fd >= 0 }

    /// Returns nil on success, or a description of the current holder.
    public func tryAcquire(holder: String) -> String? {
        if isHeld { return nil }
        let f = open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
        if f < 0 { return "unavailable (\(String(cString: strerror(errno))))" }
        if flock(f, LOCK_EX | LOCK_NB) != 0 {
            var buf = [UInt8](repeating: 0, count: 512)
            let n = pread(f, &buf, buf.count, 0)
            close(f)
            let text = n > 0 ? String(decoding: buf[0..<n], as: UTF8.self) : ""
            return text.isEmpty ? "another MoPilot window" : text
        }
        fd = f
        let info = Array("\(holder) (pid \(getpid()))".utf8)
        _ = ftruncate(f, 0)
        _ = info.withUnsafeBufferPointer { pwrite(f, $0.baseAddress, $0.count, 0) }
        return nil
    }

    public func release() {
        guard fd >= 0 else { return }
        _ = ftruncate(fd, 0)
        flock(fd, LOCK_UN)
        close(fd)
        fd = -1
    }
}
