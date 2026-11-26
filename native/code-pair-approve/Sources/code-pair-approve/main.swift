// code-pair-approve: the person's proof that another Mac may control this one (Remote Run pairing by code, #5576).
//   code-pair-approve enrol <hostId>   makes (or reuses) this user's approval key and prints {key, weak, signature}
//   code-pair-approve approve          reads the Host's fields (JSON) on stdin, shows the system prompt, prints {sig}
//   code-pair-approve text             reads the fields on stdin and prints the text it would sign (no keychain)
//   code-pair-approve commit           the staged key becomes the key (after the Host accepted the enrolment)
//   code-pair-approve abort            drops the staged key (the Host refused it, or the set-up was not finished)
//   code-pair-approve reset            removes the approval key (`mopilot-host reset-approval` removes the Host's side)
// The key is P-256. On a Mac with a Secure Enclave it is a CryptoKit Secure Enclave key with `.userPresence`, kept as
// the Enclave's own encrypted blob in a file of this user (0600; useless on any other Mac, and every use still needs the
// person's prompt). A keychain-held Secure Enclave key would need a keychain entitlement this helper does not have
// (-34018, observed). Only a Mac without a Secure Enclave (a VM) gets a software key in the login keychain, gated by this
// helper's own prompt, and the enrolment says `weak`; a Mac that has one never falls back silently.
// The text is always built here from the fields; a caller never hands a text to sign.
// Errors print {"error":{"code":…}} on stdout and exit 1: not_approved (the person cancelled or failed the prompt),
// no_key, bad_fields, keychain.
import CodePairApproveCore
import CryptoKit
import Foundation
import LocalAuthentication
import Security

let tag = Data("ai.mopilot.code.pair-approval".utf8)
let blobFile = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/MoPilot/code-pair-approval.se")
/// Where a new key waits until its enrolment was signed: the old key stays in use until then.
let stagingFile = blobFile.appendingPathExtension("new")
let stagingTag = Data("ai.mopilot.code.pair-approval.new".utf8)

func writeOut(_ object: [String: Any]) {
    let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data + Data("\n".utf8))
}

func fail(_ code: String, _ message: String = "") -> Never {
    writeOut(["error": ["code": code, "message": message]])
    exit(1)
}

/// The approval key: the Secure Enclave's, or (only without a Secure Enclave) a software key in the login keychain.
enum ApprovalKey {
    case enclave(SecureEnclave.P256.Signing.PrivateKey)
    case software(SecKey)

    var weak: Bool { if case .software = self { return true } else { return false } }

    /// The public point, uncompressed (04 || X || Y), base64.
    var point: String {
        switch self {
        case let .enclave(key): return key.publicKey.x963Representation.base64EncodedString()
        case let .software(key):
            guard let pub = SecKeyCopyPublicKey(key), let raw = SecKeyCopyExternalRepresentation(pub, nil) as Data?, raw.count == 65 else {
                fail("keychain", "the public key could not be read")
            }
            return raw.base64EncodedString()
        }
    }
}

func softwareKey() -> SecKey? { softwareKeyTagged(tag) }

func softwareKeyTagged(_ tag: Data) -> SecKey? {
    let query: [String: Any] = [
        kSecClass as String: kSecClassKey,
        kSecAttrApplicationTag as String: tag,
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecReturnRef as String: true,
    ]
    var out: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let found = out else { return nil }
    return (found as! SecKey)
}

/// The key this user enrolled; `context` carries the prompt's reason for a Secure Enclave key.
func existingKey(_ context: LAContext?) -> ApprovalKey? {
    // on a Mac with a Secure Enclave only its blob is a key: a software key in the login keychain is never looked at there
    guard SecureEnclave.isAvailable else { return softwareKey().map { .software($0) } }
    let blob: Data
    do {
        blob = try Data(contentsOf: blobFile)
    } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
        return nil
    } catch {
        // a file that is there but cannot be read is not "no key": it is never overwritten silently
        fail("keychain", "the approval key cannot be read: \(error.localizedDescription)")
    }
    guard let key = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: context) else {
        fail("keychain", "the approval key cannot be used on this Mac: reset pairing by code and set it up again")
    }
    return .enclave(key)
}

/// A new key under the staging name, with `context` carrying the prompt's reason for its first use.
func makeKey(_ context: LAContext) -> ApprovalKey {
    var error: Unmanaged<CFError>?
    if SecureEnclave.isAvailable {
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, [.privateKeyUsage, .userPresence], &error),
              let key = try? SecureEnclave.P256.Signing.PrivateKey(accessControl: access, authenticationContext: context)
        else { fail("secure_enclave", "this Mac's Secure Enclave did not make a key") }
        do {
            try FileManager.default.createDirectory(at: blobFile.deletingLastPathComponent(), withIntermediateDirectories: true)
            try key.dataRepresentation.write(to: stagingFile, options: [.atomic])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: stagingFile.path)
        } catch { fail("keychain", "the approval key could not be kept: \(error.localizedDescription)") }
        return .enclave(key)
    }
    // no Secure Enclave (a virtual Mac): a software key in the login keychain, gated by this helper's own prompt (weak)
    let attrs: [String: Any] = [
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeySizeInBits as String: 256,
        kSecPrivateKeyAttrs as String: [kSecAttrIsPermanent as String: true, kSecAttrApplicationTag as String: stagingTag],
    ]
    guard let key = SecKeyCreateRandomKey(attrs as CFDictionary, &error) else {
        fail("keychain", "\(error?.takeRetainedValue().localizedDescription ?? "the key could not be made")")
    }
    return .software(key)
}

/// The system's own prompt (Touch ID, or the password): the deliberate act this proof stands for.
func askPerson(_ context: LAContext, _ reason: String) {
    let done = DispatchSemaphore(value: 0)
    var allowed = false
    var failure = ""
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, error in
        allowed = ok
        failure = error?.localizedDescription ?? ""
        done.signal()
    }
    done.wait()
    if !allowed { fail("not_approved", failure) }
}

/// Removes the approval key wherever it is (no prompt: under option A any process of this user may; the Host then
/// accepts no pairing until it is set up again).
func removeKeys() {
    removeStaged()
    try? FileManager.default.removeItem(at: blobFile)
    SecItemDelete([kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: tag] as CFDictionary)
}

/// Drops a key that waited under the staging name (an enrolment that was not finished).
func removeStaged() {
    try? FileManager.default.removeItem(at: stagingFile)
    SecItemDelete([kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: stagingTag] as CFDictionary)
}

/// The staged key becomes the key, only after the Host accepted its enrolment: the old one is replaced at that moment.
func commitStaged() {
    let enclave = FileManager.default.fileExists(atPath: stagingFile.path)
    if !enclave, softwareKeyTagged(stagingTag) == nil { fail("no_key", "no key is waiting to be kept") }
    switch enclave {
    case true:
        do {
            _ = try FileManager.default.replaceItemAt(blobFile, withItemAt: stagingFile)
        } catch {
            do { try FileManager.default.moveItem(at: stagingFile, to: blobFile) } catch {
                fail("keychain", "the approval key could not be kept: \(error.localizedDescription)")
            }
        }
    case false:
        SecItemDelete([kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: tag] as CFDictionary)
        let query: [String: Any] = [kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: stagingTag]
        let status = SecItemUpdate(query as CFDictionary, [kSecAttrApplicationTag as String: tag] as CFDictionary)
        if status != errSecSuccess { fail("keychain", "the approval key could not be kept (status \(status))") }
    }
}

/// Signs `text`: a Secure Enclave key shows the system's prompt as it signs (with the context's reason).
func sign(_ key: ApprovalKey, _ text: String) -> String {
    switch key {
    case let .enclave(k):
        guard let sig = try? k.signature(for: Data(text.utf8)) else {
            // the Secure Enclave's own prompt was cancelled or failed
            fail("not_approved", "not signed")
        }
        return sig.derRepresentation.base64EncodedString()
    case let .software(k):
        var error: Unmanaged<CFError>?
        guard let sig = SecKeyCreateSignature(k, .ecdsaSignatureMessageX962SHA256, Data(text.utf8) as CFData, &error) as Data? else {
            fail("keychain", "\(error?.takeRetainedValue().localizedDescription ?? "not signed")")
        }
        return sig.base64EncodedString()
    }
}

func readFields() -> ApprovalFields {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard let fields = try? JSONDecoder().decode(ApprovalFields.self, from: input), let ok = try? checked(fields) else {
        fail("bad_fields", "the fields are not the Host's")
    }
    return ok
}

/// Signs `text` after the prompt: a Secure Enclave key prompts as it signs; a software key only after this helper asked.
func signAfterPrompt(_ text: String, reason: String) -> String {
    let context = LAContext()
    context.localizedReason = reason
    guard let key = existingKey(context) else { fail("no_key", "no approval key: set up pairing by code first") }
    return signWithPrompt(key, context, text, reason)
}

/// A software key is used only after this helper's own prompt; a Secure Enclave key prompts as it signs.
func signWithPrompt(_ key: ApprovalKey, _ context: LAContext, _ text: String, _ reason: String) -> String {
    if key.weak { askPerson(context, reason) }
    return sign(key, text)
}

let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "text":
    do { print(try approvalText(readFields())) } catch { fail("bad_fields") }
case "approve":
    let fields = readFields()
    guard let text = try? approvalText(fields) else { fail("bad_fields") }
    writeOut(["sig": signAfterPrompt(text, reason: approvalReason(fields))])
case "enrol":
    guard args.count == 3 else { fail("bad_fields", "usage: code-pair-approve enrol <hostId>") }
    // always a new key: a key found under the helper's tag or file could have been planted by another process of this
    // user, so enrolment never adopts one (and a weak key is replaced by a Secure Enclave key when the Mac has one).
    // It is made under a staging name and replaces the old one only on `commit`, after the Host accepted it: a cancelled,
    // failed or refused set-up leaves the key the Host knows in place.
    removeStaged()
    let reason = "set up pairing by code on this Mac"
    let context = LAContext()
    context.localizedReason = reason
    let key = makeKey(context)
    let point = key.point
    let weak = key.weak
    guard let text = try? enrolText(hostId: args[2], key: point, weak: weak) else { fail("bad_fields") }
    let signature = signWithPrompt(key, context, text, reason)
    // kept under the staging name: `commit` swaps it in once the Host accepted the enrolment, `abort` drops it
    writeOut(["key": point, "weak": weak, "signature": signature])
case "commit":
    commitStaged()
    writeOut(["committed": true])
case "abort":
    removeStaged()
    writeOut(["aborted": true])
case "reset":
    removeKeys()
    writeOut(["reset": true])
default:
    fail("bad_fields", "usage: code-pair-approve enrol <hostId> | commit | abort | approve | text | reset")
}
