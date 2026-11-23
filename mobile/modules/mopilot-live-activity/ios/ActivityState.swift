// What an ActivityKit push carries and how the widget words it: counts, a kind, a start time and up to three rows, with fixed text unless a sealed label may be opened. Foundation only, so a Mac can compile and run it on its own.
import Foundation

/// A row of the activity: its kind, when it started (unix seconds), the chat's opaque handle and, when the Mac sealed one for this phone, the title.
struct ActivityRow: Codable, Hashable {
  var kind: String
  var since: Int
  var ref: String
  var st: String?
}

/// The content state of the activity. Unix seconds, not Date: ActivityKit decodes a push with a default JSONDecoder, whose Date encoding is not what a relay would send.
/// A field this app does not know is ignored by the decoder; a missing `rows` reads as none.
struct ActivityState: Codable, Hashable {
  var needs: Int
  var running: Int
  var kind: String
  var since: Int
  var rows: [ActivityRow]

  init(needs: Int, running: Int, kind: String, since: Int, rows: [ActivityRow] = []) {
    self.needs = needs
    self.running = running
    self.kind = kind
    self.since = since
    self.rows = rows
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    needs = try c.decode(Int.self, forKey: .needs)
    running = try c.decode(Int.self, forKey: .running)
    kind = try c.decode(String.self, forKey: .kind)
    since = try c.decode(Int.self, forKey: .since)
    rows = try c.decodeIfPresent([ActivityRow].self, forKey: .rows) ?? []
  }

  /// Nothing running or waiting: the "Finished" frame the system keeps for a short while.
  var isFinished: Bool { needs + running == 0 }
}

/// The words on the lock screen and in the Dynamic Island.
enum ActivityText {
  static let maxRows = 3

  /// The fixed text of a kind; the same strings as the fixed push titles.
  static func fixed(_ kind: String) -> String {
    switch kind {
    case "needs": return "A chat needs you"
    case "done": return "A chat finished"
    default: return "A chat is running"
    }
  }

  /// "1 needs you · 2 running"; "Finished" once nothing is running or waiting.
  static func headline(_ state: ActivityState) -> String {
    var parts: [String] = []
    if state.needs > 0 { parts.append(state.needs == 1 ? "1 needs you" : "\(state.needs) need you") }
    if state.running > 0 { parts.append("\(state.running) running") }
    return parts.isEmpty ? "Finished" : parts.joined(separator: " · ")
  }

  /// The number in the island's compact and minimal views: what needs the person, else what runs, and a check mark once nothing is left (never a bare 0).
  static func islandCount(_ state: ActivityState) -> String {
    if state.isFinished { return "✓" }
    return String(state.needs > 0 ? state.needs : state.running)
  }

  /// The line under the rows: what opening the app is for.
  static func footer(_ state: ActivityState) -> String {
    if state.isFinished { return "Open MoPilot to review" }
    return state.needs > 0 ? "Open MoPilot to answer" : "Open MoPilot"
  }

  /// A row's label: the opened title only when titles are allowed, the row carries one and `open` can open it; otherwise the fixed text of its kind.
  static func label(_ row: ActivityRow, titlesAllowed: Bool, open: (String, String) -> String?) -> String {
    if titlesAllowed, let sealed = row.st, let title = open(sealed, row.ref) { return title }
    return fixed(row.kind)
  }

  /// Up to three rows. The Mac's own rows when it sent any; otherwise one per kind that has a count, from the activity's start, so the lock screen is never empty while something runs.
  static func rows(_ state: ActivityState) -> [ActivityRow] {
    if !state.rows.isEmpty { return Array(state.rows.prefix(maxRows)) }
    var out: [ActivityRow] = []
    if state.needs > 0 { out.append(ActivityRow(kind: "needs", since: state.since, ref: "", st: nil)) }
    if state.running > 0 { out.append(ActivityRow(kind: "running", since: state.since, ref: "", st: nil)) }
    if state.isFinished { out.append(ActivityRow(kind: "done", since: 0, ref: "", st: nil)) }
    return out
  }
}
