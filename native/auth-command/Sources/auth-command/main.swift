import Foundation
import Security

// auth-command get <service> <account>      prints the key; exits 1 at once when there is none or when the
//                                           keychain would have to ask the user (no dialog, no waiting)
// auth-command set <service> <account>      stores the key read from stdin. main calls this; the item is
//                                           created by this binary, so this binary reads it back silently
// auth-command delete <service> <account>   removes the item
// Codex runs `get` at every thread/start, so it does one keychain read and nothing else.

// write(2) only: FileHandle.write raises an ObjC exception (and aborts) when the reader has closed the pipe.
func writeAll(_ fd: Int32, _ data: Data) -> Bool {
    data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) -> Bool in
        var off = 0
        while off < buf.count {
            let n = write(fd, buf.baseAddress! + off, buf.count - off)
            if n < 0 {
                if errno == EINTR { continue }
                return false
            }
            off += n
        }
        return true
    }
}

signal(SIGPIPE, SIG_IGN)

func fail(_ message: String) -> Never {
    _ = writeAll(2, Data("auth-command: \(message)\n".utf8))
    exit(1)
}

let args = CommandLine.arguments
guard args.count == 4 else { fail("usage: auth-command get|set|delete <service> <account>") }
let mode = args[1]
let base: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: args[2],
    kSecAttrAccount as String: args[3],
]

switch mode {
case "get":
    var query = base
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    // fail instead of prompting when the item's access list doesn't include this binary
    query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail
    var out: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &out)
    guard status == errSecSuccess, let data = out as? Data, let key = String(data: data, encoding: .utf8), !key.isEmpty else {
        fail("no key (status \(status))")
    }
    if !writeAll(1, Data((key + "\n").utf8)) { exit(1) }
case "set":
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard let text = String(data: input, encoding: .utf8) else { fail("key is not text") }
    let key = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if key.isEmpty { fail("empty key") }
    SecItemDelete(base as CFDictionary)
    var add = base
    add[kSecValueData as String] = Data(key.utf8)
    let status = SecItemAdd(add as CFDictionary, nil)
    if status != errSecSuccess { fail("could not store (status \(status))") }
case "delete":
    let status = SecItemDelete(base as CFDictionary)
    if status != errSecSuccess && status != errSecItemNotFound { fail("could not delete (status \(status))") }
default:
    fail("unknown mode \(mode)")
}
