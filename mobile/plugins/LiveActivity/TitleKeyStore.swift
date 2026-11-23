// The widget's read of the "Chat titles on lock screen" switch the app keeps in the App Group, and the rule for when a sealed row label may be opened.
import Foundation

enum TitleKeyStore {
  /// The app writes the switch to the App Group; absent means off.
  static func titlesSwitchOn() -> Bool {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "MPAppGroup") as? String,
      let defaults = UserDefaults(suiteName: group)
    else { return false }
    return defaults.bool(forKey: "liveActivityTitles")
  }

  /// A sealed row is opened only with the switch on and at least one key; anything else shows the fixed text. The keys are read once, here, and only when allowed.
  static func keysIfAllowed() -> [[UInt8]]? {
    guard titlesSwitchOn() else { return nil }
    let keys = SealedTitle.titleKeys()
    return keys.isEmpty ? nil : keys
  }
}
