// iOS Notification Service Extension: open the optional sealed chat title, and MoMo's optional sealed body (the user's own routine name, A6), with libsodium, else ship the relay's alert unchanged.
import Foundation
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
  private let lock = NSLock()
  private var handler: ((UNNotificationContent) -> Void)?
  private var best: UNMutableNotificationContent?

  override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    handler = contentHandler
    best = request.content.mutableCopy() as? UNMutableNotificationContent
    // The title is already the fixed text; only a successful open replaces it, every failure leaves it as it is.
    // MoMo's body: set only when its own blob opens (the same keys exist only while this phone's titles switch is on); no body otherwise, never an error text.
    if let content = best, let body = NotificationService.openBody(content.userInfo) { content.body = body }
    if let content = best, let title = NotificationService.openTitle(content.userInfo) {
      content.title = title
      NotificationService.note("opened")
    } else if best != nil, request.content.userInfo["st"] != nil, !NotificationService.isMerged(request.content.userInfo) {
      NotificationService.countFallback()
      NotificationService.note("fallback")
    }
    finish()
  }

  /// The system calls this about 30 seconds in; the content as it stands is delivered.
  override func serviceExtensionTimeWillExpire() {
    NotificationService.countFallback()
    finish()
  }

  /// Delivers once, whichever of the normal path and the expiry gets here first.
  private func finish() {
    lock.lock()
    defer { lock.unlock() }
    guard let done = handler, let content = best else { return }
    handler = nil
    done(content)
  }

  // MARK: sealed title

  /// Several chats merged into one notification keep the relay's "(n)" title; that is by design, not a failure.
  static func isMerged(_ info: [AnyHashable: Any]) -> Bool {
    if let count = (info["count"] as? Int) ?? Int(info["count"] as? String ?? "") { return count > 1 }
    return false
  }

  /// The push's `st` key, bound to the push's ref (see SealedTitle). Reads the per-pair title keys; it never touches the app's session ratchet.
  static func openTitle(_ info: [AnyHashable: Any]) -> String? {
    guard let sealed = info["st"] as? String, let ref = info["ref"] as? String else { return nil }
    if isMerged(info) { return nil }
    return SealedTitle.open(sealed, ref: ref, keys: SealedTitle.titleKeys())
  }

  /// The push's `sb` key for a MoMo "needs you", bound to the push's ref (see SealedTitle.openBody). Several chats merged into one notification carry none.
  static func openBody(_ info: [AnyHashable: Any]) -> String? {
    guard (info["kind"] as? String) == "momoNeedsYou", let sealed = info["sb"] as? String, let ref = info["ref"] as? String else { return nil }
    if isMerged(info) { return nil }
    return SealedTitle.openBody(sealed, ref: ref, keys: SealedTitle.titleKeys())
  }

  /// The last outcome of a sealed push and a count of opened ones, kept in the App Group for a device check to read; never the title itself.
  static func note(_ result: String) {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "MPAppGroup") as? String,
      let defaults = UserDefaults(suiteName: group)
    else { return }
    defaults.set(result, forKey: "sealedTitleLast")
    if result == "opened" { defaults.set(defaults.integer(forKey: "sealedTitleOpened") + 1, forKey: "sealedTitleOpened") }
  }

  /// A count of sealed titles that fell back to the fixed one, kept in the App Group for the app to show; never the title itself.
  static func countFallback() {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "MPAppGroup") as? String,
      let defaults = UserDefaults(suiteName: group)
    else { return }
    defaults.set(defaults.integer(forKey: "sealedTitleFallbacks") + 1, forKey: "sealedTitleFallbacks")
  }
}
