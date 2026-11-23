// The app side of the Live Activity: starts it with the counts the phone knows, updates and ends it, hands JS the push-to-update token (the relay sends it to Apple), and writes the "Chat titles on lock screen" switch to the App Group where the widget reads it.
import ActivityKit
import ExpoModulesCore

public final class MoPilotLiveActivityModule: Module {
  private var tokenTask: Task<Void, Never>?

  public func definition() -> ModuleDefinition {
    Name("MoPilotLiveActivity")
    Events("onToken", "onEnded")

    /// Whether the person allows Live Activities for this app (Settings > MoPilot > Live Activities). Asking nothing.
    AsyncFunction("isEnabled") { () async -> Bool in
      ActivityAuthorizationInfo().areActivitiesEnabled
    }

    /// Starts the activity, or adopts the one that is already running (a relaunch) untouched, and starts reporting its push token. The system asks the person for permission on the first start, so this is only called once the switch is on.
    AsyncFunction("start") { (state: [String: Any]) async throws -> Bool in
      let content = try Self.decode(state)
      // the relay's pushes are the activity's truth: an activity that is already running is only watched again, never overwritten with the phone's counts
      // (an ended activity still showing its Finished frame is not adopted: a new run needs a new activity)
      if let running = Activity<MoPilotActivityAttributes>.activities.first(where: { $0.activityState == .active }) {
        self.watch(running)
        return true
      }
      guard ActivityAuthorizationInfo().areActivitiesEnabled else { return false }
      let activity = try Activity.request(
        attributes: MoPilotActivityAttributes(),
        content: ActivityContent(state: content, staleDate: nil),
        pushType: .token
      )
      self.watch(activity)
      return true
    }

    AsyncFunction("update") { (state: [String: Any]) async throws in
      let content = try Self.decode(state)
      for activity in Activity<MoPilotActivityAttributes>.activities {
        await activity.update(ActivityContent(state: content, staleDate: nil))
      }
    }

    /// Removes the sealed title of every row of the running activity: used when the person turns chat titles off, so a title already pushed does not stay on the lock screen.
    AsyncFunction("stripTitles") { () async in
      for activity in Activity<MoPilotActivityAttributes>.activities {
        var state = activity.content.state
        state.rows = state.rows.map { ActivityRow(kind: $0.kind, since: $0.since, ref: $0.ref, st: nil) }
        await activity.update(ActivityContent(state: state, staleDate: activity.content.staleDate))
      }
    }

    /// Ends every running activity at once.
    AsyncFunction("end") { () async in
      self.tokenTask?.cancel()
      self.tokenTask = nil
      for activity in Activity<MoPilotActivityAttributes>.activities {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
    }

    /// The current activity's push token (hex), when it has one yet.
    AsyncFunction("token") { () -> String? in
      Activity<MoPilotActivityAttributes>.activities.first(where: { $0.activityState == .active })?.pushToken.map { Self.hex($0) }
    }

    /// The Live Activity switch, kept in the app's own defaults: unlike the keychain they go with an uninstall, so a reinstalled app starts with the switch off.
    AsyncFunction("loadPrefs") { () -> String? in
      UserDefaults.standard.string(forKey: "liveActivityPrefs")
    }

    AsyncFunction("savePrefs") { (raw: String) in
      UserDefaults.standard.set(raw, forKey: "liveActivityPrefs")
    }

    /// The switch the widget reads; absent means off.
    AsyncFunction("setTitlesSwitch") { (on: Bool) -> Bool in
      guard let group = Bundle.main.object(forInfoDictionaryKey: "MPAppGroup") as? String,
        let defaults = UserDefaults(suiteName: group)
      else { return false }
      defaults.set(on, forKey: "liveActivityTitles")
      return true
    }
  }

  /// Reports the activity's token now and whenever the system changes it, and tells JS when the activity ends (the person dismissed it, or it timed out).
  private func watch(_ activity: Activity<MoPilotActivityAttributes>) {
    tokenTask?.cancel()
    tokenTask = Task { [weak self] in
      await withTaskGroup(of: Void.self) { group in
        group.addTask {
          for await data in activity.pushTokenUpdates { self?.sendEvent("onToken", ["token": Self.hex(data)]) }
        }
        group.addTask {
          // `dismissed` is the person removing a running activity; `ended` is the end the relay or the app asked for, or a timeout
          for await state in activity.activityStateUpdates where state == .ended || state == .dismissed {
            self?.sendEvent("onEnded", ["dismissed": state == .dismissed])
            return
          }
        }
      }
    }
  }

  private static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

  private static func decode(_ state: [String: Any]) throws -> ActivityState {
    try JSONDecoder().decode(ActivityState.self, from: JSONSerialization.data(withJSONObject: state))
  }
}
