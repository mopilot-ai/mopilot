// Opens a chat title, and MoMo's opt-in push body (A6), sealed for this phone, for the Notification Service Extension and the Live Activity widget alike: the per-pair title keys come from the shared keychain, and the AEAD tag decides which one belongs to a blob.
import Foundation
import Security
import Sodium

enum SealedTitle {
  static let aadPrefix = "mopilot-push-title-v1|"
  /// MoMo's push body: its own prefix, so a title can never be read as a body (shared/remote/pushSettings.mjs PUSH_BODY_AAD_PREFIX; vectors in tests/fixtures/push-body-vectors.json).
  static let bodyAadPrefix = "mopilot-push-body-v1|"
  static let nonceBytes = 24
  static let tagBytes = 16

  /// base64url(nonce24 || box), bound to the chat's opaque ref. Nil on any failure: the caller shows the fixed text.
  static func open(_ sealed: String, ref: String, keys: [[UInt8]], aadPrefix: String = SealedTitle.aadPrefix) -> String? {
    var std = sealed.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while std.count % 4 != 0 { std += "=" }
    guard let blob = Data(base64Encoded: std), blob.count > nonceBytes + tagBytes else { return nil }
    let nonce = Array(blob.prefix(nonceBytes))
    let box = Array(blob.dropFirst(nonceBytes))
    let aad = Array((aadPrefix + ref).utf8)
    let sodium = Sodium()
    for key in keys {
      if let plain = sodium.aead.xchacha20poly1305ietf.decrypt(
        authenticatedCipherText: box, secretKey: key, nonce: nonce, additionalData: aad
      ), plain.count <= 200, let text = String(bytes: plain, encoding: .utf8) {
        let cleaned = text.unicodeScalars.map { CharacterSet.controlCharacters.contains($0) ? " " : String($0) }.joined()
          .trimmingCharacters(in: .whitespaces)
        if !cleaned.isEmpty { return cleaned }
      }
    }
    return nil
  }

  /// MoMo's sealed push body: the same rules under the body's AAD (the Mac pads it with spaces, which the cleaning drops). Nil on any failure: the notification then has no body.
  static func openBody(_ sealed: String, ref: String, keys: [[UInt8]]) -> String? {
    open(sealed, ref: ref, keys: keys, aadPrefix: bodyAadPrefix)
  }

  /// Every stored title key; reads only the title keys, never the vault or the session ratchet.
  /// expo-secure-store keeps an item under "<service>:no-auth" (":auth" when it asks for authentication), never under the bare service, and the keychain matches a service exactly: the bare name is read too for keys an older build stored. The AEAD tag decides which key belongs to a push.
  static func titleKeys() -> [[UInt8]] {
    let service = (Bundle.main.object(forInfoDictionaryKey: "MPKeychainService") as? String) ?? "mopilot-push"
    return ["\(service):no-auth", service].map { titleKeys(service: $0) }.flatMap { $0 }
  }

  /// The title keys stored under one keychain service.
  static func titleKeys(service: String) -> [[UInt8]] {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecReturnData as String: true,
      kSecReturnAttributes as String: true,
      kSecMatchLimit as String: kSecMatchLimitAll,
    ]
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let items = result as? [[String: Any]] else { return [] }
    let sodium = Sodium()
    return items.compactMap { item in
      guard let account = (item[kSecAttrAccount as String] as? String) ?? (item[kSecAttrAccount as String] as? Data).flatMap({ String(data: $0, encoding: .utf8) }),
        account.hasPrefix("title-key."),
        let data = item[kSecValueData as String] as? Data,
        let hex = String(data: data, encoding: .utf8), hex.count == 64
      else { return nil }
      return sodium.utils.hex2bin(hex)
    }
  }
}
