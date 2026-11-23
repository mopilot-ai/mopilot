#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif
import Foundation

// `sage-mcp --chrome-native-host <socket> <origin>`: the native messaging host of MoPilot's Chrome extension
// (#1632). Chrome starts it (through the launcher script MoPilot writes, electron/capabilities/browser/
// chromeNativeHost.cjs) with the calling extension's origin, and speaks Chrome's native messaging on stdio: each
// message is a 4-byte length in native byte order, then that many bytes of JSON. The host reads one message,
// passes it to MoPilot's main over the unix socket as one line, `{"type":"hello","pid","origin","request"}`,
// writes main's one-line answer back as one message, and exits. Main checks the kernel's word on who connected
// and who started it; the host itself decides nothing. When main can't be reached it answers `{"type":"none"}`.

/// Reads exactly `count` bytes from `fd`, or nil at end of input.
func readExactly(_ fd: Int32, _ count: Int) -> Data? {
    var data = Data()
    var chunk = [UInt8](repeating: 0, count: max(1, min(count, 65536)))
    while data.count < count {
        let n = read(fd, &chunk, min(chunk.count, count - data.count))
        if n < 0 && errno == EINTR { continue }
        if n <= 0 { return nil }
        data.append(chunk, count: n)
    }
    return data
}

/// Writes one native messaging message (length, then the JSON) to stdout.
func writeMessage(_ obj: [String: Any]) {
    let body = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
    var length = UInt32(body.count)
    var framed = Data(bytes: &length, count: 4)
    framed.append(body)
    _ = writeAll(1, framed)
}

/// The MoPilot app this host runs from (its Contents/Helpers/sage-mcp), started with `open`; false outside an app
/// (a developer build) or when it can't be started. MOPILOT_HOST_OPEN stands in for /usr/bin/open in tests.
func startOwningApp() -> Bool {
    let exe = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
    let helpers = exe.deletingLastPathComponent()
    let app = helpers.deletingLastPathComponent().deletingLastPathComponent()
    guard helpers.lastPathComponent == "Helpers", app.pathExtension == "app" else { return false }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["MOPILOT_HOST_OPEN"] ?? "/usr/bin/open")
    p.arguments = [app.path]
    guard (try? p.run()) != nil else { return false }
    p.waitUntilExit()
    return p.terminationStatus == 0
}

/// Chrome's limit on a message to a host is 4 GB; the extension asks with a few bytes, so anything larger is refused.
let maxRequest = 64 * 1024

func runChromeNativeHost(socketPath: String, origin: String) -> Never {
    guard let head = readExactly(0, 4) else { exit(0) }
    let length = head.withUnsafeBytes { Int($0.loadUnaligned(as: UInt32.self)) }
    guard length > 0, length <= maxRequest, let body = readExactly(0, length),
          let request = try? JSONSerialization.jsonObject(with: body) else {
        writeMessage(["type": "error", "reason": "unreadable request"])
        exit(0)
    }
    let fd = socket(AF_UNIX, sockStream, 0)
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(socketPath.utf8)
    guard fd >= 0, bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else {
        writeMessage(["type": "none", "reason": "MoPilot isn't reachable"])
        exit(0)
    }
    withUnsafeMutableBytes(of: &addr.sun_path) { buf in
        for (i, b) in bytes.enumerated() { buf[i] = b }
        buf[bytes.count] = 0
    }
    let rc = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    if rc != 0 {
        // the user asked from Chrome to open MoPilot (its page's "Open MoPilot", #1986): start the app this host
        // belongs to and say so; the extension asks again, through the launcher the started app writes anew
        if let r = request as? [String: Any], r["type"] as? String == "open", r["what"] as? String == "app", startOwningApp() {
            writeMessage(["type": "none", "starting": true, "reason": "Starting MoPilot"])
            exit(0)
        }
        writeMessage(["type": "none", "reason": "MoPilot isn't running"])
        exit(0)
    }
    noSigPipe(fd)
    // main answers within seconds (it reads the process table and the browser's signature); a stuck main doesn't hold Chrome's call
    var wait = timeval(tv_sec: 15, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &wait, socklen_t(MemoryLayout<timeval>.size))
    let hello: [String: Any] = ["type": "hello", "pid": Int(getpid()), "origin": origin, "request": request]
    guard writeAll(fd, encode(hello)), let line = LineReader(fd: fd).next(),
          let answer = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else {
        writeMessage(["type": "none", "reason": "MoPilot didn't answer"])
        exit(0)
    }
    writeMessage(answer)
    exit(0)
}
