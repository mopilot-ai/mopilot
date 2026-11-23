import Darwin
import Foundation
import HelperCore
import Security

/// A unix-socket server speaking newline-delimited JSON-RPC 2.0. One connection at a time, from the
/// registered main pid (checked against the kernel's audit token), opened with `hello {token}`.
final class Server {
    /// `turn`: the request's `(chat, turn)` token field as sent (TurnToken parses it); nil when there is none.
    typealias Handler = (_ method: String, _ params: [String: Any], _ turn: Any?, _ reply: @escaping (Result<Any, HelperError>) -> Void) -> Void

    let path: String
    let expectedPid: Int32
    let token: String
    /// Code requirement the peer must satisfy (from the helper's own signed Info.plist). Nil in ad-hoc
    /// dev builds, where pid + token is the whole check.
    let peerRequirement: String?
    var handler: Handler?
    var onDisconnect: (() -> Void)?
    var onAuthenticated: (() -> Void)?

    private var listenFd: Int32 = -1
    private var clientFd: Int32 = -1
    private let writeLock = NSLock()
    private let stateLock = NSLock()

    init(path: String, expectedPid: Int32, token: String, peerRequirement: String?) {
        self.path = path
        self.expectedPid = expectedPid
        self.token = token
        self.peerRequirement = peerRequirement
    }

    func start() throws {
        var st = stat()
        if lstat(path, &st) == 0, (st.st_mode & S_IFMT) == S_IFSOCK { unlink(path) }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw posixError("socket") }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { throw posixError("socket path too long") }
        withUnsafeMutableBytes(of: &addr.sun_path) { buf in
            for (i, b) in bytes.enumerated() { buf[i] = b }
            buf[bytes.count] = 0
        }
        // Owner-only from the moment it exists.
        let oldMask = umask(0o177)
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        umask(oldMask)
        guard rc == 0 else { close(fd); throw posixError("bind") }
        chmod(path, 0o600)
        guard listen(fd, 4) == 0 else { close(fd); throw posixError("listen") }
        listenFd = fd
        Thread.detachNewThread { [weak self] in self?.acceptLoop() }
    }

    func stop() {
        if listenFd >= 0 { close(listenFd); listenFd = -1 }
        unlink(path)
    }

    /// Send a JSON-RPC notification to the connected client, if any.
    func notify(_ method: String, _ params: [String: Any]) {
        stateLock.lock()
        let fd = clientFd
        stateLock.unlock()
        if fd >= 0 { send(fd, ["jsonrpc": "2.0", "method": method, "params": params]) }
    }

    private func acceptLoop() {
        while listenFd >= 0 {
            let fd = accept(listenFd, nil, nil)
            if fd < 0 {
                if errno == EINTR { continue }
                return
            }
            var one: Int32 = 1
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
            stateLock.lock()
            let busy = clientFd >= 0
            stateLock.unlock()
            let (tokenPid, audit) = peerAuditToken(fd)
            let verdict = checkPeer(tokenPid: tokenPid, peerPid: peerPid(fd), expectedPid: expectedPid, busy: busy)
            if case .reject(let why) = verdict {
                log("rejected connection: \(why)")
                close(fd)
                continue
            }
            if let req = peerRequirement, let audit, !peerSatisfies(audit: audit, requirement: req) {
                log("rejected connection: peer signature does not satisfy the requirement")
                close(fd)
                continue
            }
            stateLock.lock()
            clientFd = fd
            stateLock.unlock()
            Thread.detachNewThread { [weak self] in self?.serve(fd) }
        }
    }

    private func serve(_ fd: Int32) {
        var buffer = Data()
        var authed = false
        var chunk = [UInt8](repeating: 0, count: 65536)
        outer: while true {
            let n = read(fd, &chunk, chunk.count)
            if n <= 0 { break }
            buffer.append(chunk, count: n)
            while let nl = buffer.firstIndex(of: 0x0A) {
                let line = buffer.subdata(in: buffer.startIndex..<nl)
                buffer.removeSubrange(buffer.startIndex...nl)
                if line.isEmpty { continue }
                guard let msg = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any],
                      let method = msg["method"] as? String else {
                    send(fd, ["jsonrpc": "2.0", "id": NSNull(), "error": ["code": -32700, "message": "parse error"]])
                    continue
                }
                let id = msg["id"] ?? NSNull()
                let params = msg["params"] as? [String: Any] ?? [:]
                if !authed {
                    // The first message must be hello with the per-launch token; anything else ends the connection.
                    guard method == "hello", let t = params["token"] as? String, tokensEqual(t, token) else {
                        reply(fd, id, .failure(.unauthorized))
                        break outer
                    }
                    authed = true
                    onAuthenticated?()
                }
                handler?(method, params, msg["turn"]) { [weak self] result in self?.reply(fd, id, result) }
            }
        }
        stateLock.lock()
        if clientFd == fd { clientFd = -1 }
        stateLock.unlock()
        close(fd)
        if authed { onDisconnect?() }
    }

    private func reply(_ fd: Int32, _ id: Any, _ result: Result<Any, HelperError>) {
        switch result {
        case .success(let value):
            send(fd, ["jsonrpc": "2.0", "id": id, "result": value])
        case .failure(let e):
            send(fd, ["jsonrpc": "2.0", "id": id, "error": ["code": e.code, "message": e.message, "data": ["reason": e.reason]]])
        }
    }

    private func send(_ fd: Int32, _ obj: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: obj) else { return }
        data.append(0x0A)
        writeLock.lock()
        defer { writeLock.unlock() }
        data.withUnsafeBytes { raw in
            var off = 0
            while off < raw.count {
                let w = write(fd, raw.baseAddress! + off, raw.count - off)
                if w <= 0 { if errno == EINTR { continue }; return }
                off += w
            }
        }
    }
}

/// The peer's audit token (LOCAL_PEERTOKEN) and the pid inside it.
private func peerAuditToken(_ fd: Int32) -> (Int32?, audit_token_t?) {
    var token = audit_token_t()
    var len = socklen_t(MemoryLayout<audit_token_t>.size)
    guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &len) == 0 else { return (nil, nil) }
    let v = token.val
    return (pidFromAuditToken([v.0, v.1, v.2, v.3, v.4, v.5, v.6, v.7]), token)
}

private func peerPid(_ fd: Int32) -> Int32? {
    var pid: pid_t = 0
    var len = socklen_t(MemoryLayout<pid_t>.size)
    return getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &len) == 0 ? pid : nil
}

/// Checks the peer process's code signature, identified by its audit token so a pid reuse can't fool it.
private func peerSatisfies(audit: audit_token_t, requirement: String) -> Bool {
    var token = audit
    let data = Data(bytes: &token, count: MemoryLayout<audit_token_t>.size)
    var code: SecCode?
    guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributeAudit: data] as CFDictionary, [], &code) == errSecSuccess,
          let code else { return false }
    var req: SecRequirement?
    guard SecRequirementCreateWithString(requirement as CFString, [], &req) == errSecSuccess, let req else { return false }
    return SecCodeCheckValidity(code, [], req) == errSecSuccess
}

private func posixError(_ what: String) -> NSError {
    NSError(domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: [NSLocalizedDescriptionKey: "\(what): \(String(cString: strerror(errno)))"])
}

func log(_ s: String) {
    // write(2), not FileHandle: that raises an ObjC exception when stderr's reader has gone away
    let bytes = Array("[computer-use] \(s)\n".utf8)
    var off = 0
    while off < bytes.count {
        let n = bytes[off...].withUnsafeBytes { write(2, $0.baseAddress, $0.count) }
        if n < 0 {
            if errno == EINTR { continue }
            return
        }
        off += n
    }
}
