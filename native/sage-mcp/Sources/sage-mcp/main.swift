#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif
import Foundation

// SOCK_STREAM is a Swift enum on Linux (glibc) and an Int32 on macOS
#if os(Linux)
let sockStream = Int32(SOCK_STREAM.rawValue)
#else
let sockStream = SOCK_STREAM
#endif

// SO_NOSIGPIPE exists on macOS only; elsewhere SIGPIPE is ignored for the whole process (below), which has the same effect
func noSigPipe(_ fd: Int32) {
    #if !os(Linux)
    var one: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
    #endif
}

// sage-mcp speaks MCP (newline-delimited JSON-RPC 2.0) on stdio to the harness that launched it.
// It answers initialize and ping itself and forwards tools/list and tools/call, line for line, to
// MoPilot's main process over the unix socket in SAGE_MCP_SOCKET. The first line on that socket
// is `hello {token, pid, ppid}`; main checks the token and that this process's parent is the harness
// it gave the token to, and closes the socket otherwise. Started with --chrome-native-host it is instead the native
// messaging host of MoPilot's Chrome extension (ChromeHost.swift).

let version = "1.0.0"

// Writes go through write(2) only: FileHandle.write raises an ObjC exception on EPIPE or a closed fd,
// which aborts the process and makes macOS show a crash dialog every time a harness exits.
func fail(_ message: String) -> Never {
    _ = writeAll(2, Data("sage-mcp: \(message)\n".utf8))
    exit(1)
}

func encode(_ obj: [String: Any]) -> Data {
    var data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
    data.append(0x0A)
    return data
}

func writeAll(_ fd: Int32, _ data: Data) -> Bool {
    data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) -> Bool in
        if buf.count == 0 { return true }
        var off = 0
        while off < buf.count {
            let n = write(fd, buf.baseAddress! + off, buf.count - off)
            if n < 0 {
                if errno == EINTR { continue }
                if errno == EAGAIN {
                    var p = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
                    _ = poll(&p, 1, 1000)
                    continue
                }
                return false
            }
            off += n
        }
        return true
    }
}

/// Reads newline-terminated lines from a file descriptor.
final class LineReader {
    let fd: Int32
    private var buffer = Data()
    private var chunk = [UInt8](repeating: 0, count: 65536)

    init(fd: Int32) { self.fd = fd }

    func next() -> Data? {
        while true {
            if let nl = buffer.firstIndex(of: 0x0A) {
                let line = buffer.subdata(in: buffer.startIndex..<nl)
                buffer.removeSubrange(buffer.startIndex...nl)
                return line
            }
            let n = read(fd, &chunk, chunk.count)
            if n < 0 && errno == EINTR { continue }
            if n <= 0 { return nil }
            buffer.append(chunk, count: n)
        }
    }
}

/// stdout is written from two threads (local replies and main's replies), one whole line at a time.
final class Output {
    private let lock = NSLock()
    func line(_ data: Data) {
        lock.lock()
        defer { lock.unlock() }
        var d = data
        if d.last != 0x0A { d.append(0x0A) }
        if !writeAll(1, d) { exit(0) }
    }
    func json(_ obj: [String: Any]) { line(encode(obj)) }
}

func connectUnix(_ path: String) -> Int32 {
    let fd = socket(AF_UNIX, sockStream, 0)
    if fd < 0 { fail("socket: \(String(cString: strerror(errno)))") }
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    if bytes.count >= MemoryLayout.size(ofValue: addr.sun_path) { fail("socket path too long") }
    withUnsafeMutableBytes(of: &addr.sun_path) { buf in
        for (i, b) in bytes.enumerated() { buf[i] = b }
        buf[bytes.count] = 0
    }
    let rc = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    if rc != 0 { fail("can't reach MoPilot: \(String(cString: strerror(errno)))") }
    noSigPipe(fd)
    return fd
}

signal(SIGPIPE, SIG_IGN)
// Chrome starts the same binary as MoPilot's extension's native messaging host (ChromeHost.swift)
let arguments = CommandLine.arguments
if arguments.count >= 3, arguments[1] == "--chrome-native-host" {
    runChromeNativeHost(socketPath: arguments[2], origin: arguments.count > 3 ? arguments[3] : "")
}
let env = ProcessInfo.processInfo.environment
guard let socketPath = env["SAGE_MCP_SOCKET"], !socketPath.isEmpty else { fail("SAGE_MCP_SOCKET is not set") }
guard let token = env["SAGE_MCP_TOKEN"], !token.isEmpty else { fail("SAGE_MCP_TOKEN is not set") }

let sock = connectUnix(socketPath)
let fromMain = LineReader(fd: sock)
let hello: [String: Any] = [
    "jsonrpc": "2.0", "id": "hello", "method": "hello",
    "params": ["token": token, "pid": Int(getpid()), "ppid": Int(getppid()), "version": version],
]
if !writeAll(sock, encode(hello)) { fail("MoPilot closed the connection") }
guard let helloLine = fromMain.next(),
      let helloReply = (try? JSONSerialization.jsonObject(with: helloLine)) as? [String: Any] else {
    fail("MoPilot refused the connection")
}
if let err = helloReply["error"] as? [String: Any] { fail("MoPilot refused the connection: \(err["message"] ?? "")") }
let serverName = ((helloReply["result"] as? [String: Any])?["serverName"] as? String) ?? "sage"

let out = Output()

// main -> harness: replies to forwarded requests, and list_changed when a tiered session's list grew at a turn's end,
// passed through as they are.
Thread.detachNewThread {
    while let line = fromMain.next() {
        if !line.isEmpty { out.line(line) }
    }
    // main went away (or revoked this session): nothing more can be served
    exit(0)
}

// harness -> sage-mcp
let stdinLines = LineReader(fd: 0)
while let line = stdinLines.next() {
    if line.isEmpty { continue }
    guard let msg = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else {
        out.json(["jsonrpc": "2.0", "id": NSNull(), "error": ["code": -32700, "message": "Parse error"]])
        continue
    }
    // the harness cancelling one call goes to main, which stops that call; it needs no answer
    if msg["method"] as? String == "notifications/cancelled", msg["id"] == nil {
        var d = line
        d.append(0x0A)
        _ = writeAll(sock, d)
        continue
    }
    // other notifications and responses need no answer; sage-mcp never asks the harness anything
    guard let method = msg["method"] as? String, let id = msg["id"], !(id is NSNull) else { continue }
    switch method {
    case "initialize":
        let params = msg["params"] as? [String: Any]
        out.json(["jsonrpc": "2.0", "id": id, "result": [
            "protocolVersion": params?["protocolVersion"] as? String ?? "2025-06-18",
            "capabilities": ["tools": ["listChanged": true]],
            "serverInfo": ["name": serverName, "version": version],
        ] as [String: Any]])
    case "ping":
        out.json(["jsonrpc": "2.0", "id": id, "result": [String: Any]()])
    case "tools/list", "tools/call":
        var d = line
        d.append(0x0A)
        if !writeAll(sock, d) {
            out.json(["jsonrpc": "2.0", "id": id, "error": ["code": -32603, "message": "MoPilot is not reachable"]])
        }
    default:
        out.json(["jsonrpc": "2.0", "id": id, "error": ["code": -32601, "message": "Method not found: \(method)"]])
    }
}
exit(0)
