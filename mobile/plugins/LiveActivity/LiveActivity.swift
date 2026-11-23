// iOS Live Activity widget: the lock screen card and the Dynamic Island. Counts, a start time drawn on the phone and fixed row text; sealed row labels are opened here only when the person turned titles on. The only action is opening the app.
import ActivityKit
import SwiftUI
import WidgetKit

@main
struct LiveActivityBundle: WidgetBundle {
  var body: some Widget { MoPilotLiveActivity() }
}

private let amber = Color(red: 0.94, green: 0.55, blue: 0.34)
private let openURL = URL(string: "mopilot://")!

/// The rows as the card shows them: label (opened or fixed), kind and start time. Keys are read once per render, and only when titles are on.
private func shownRows(_ state: ActivityState) -> [(id: Int, kind: String, since: Int, label: String)] {
  let keys = TitleKeyStore.keysIfAllowed()
  return ActivityText.rows(state).enumerated().map { index, row in
    let label = ActivityText.label(row, titlesAllowed: keys != nil) { sealed, ref in SealedTitle.open(sealed, ref: ref, keys: keys ?? []) }
    return (index, row.kind, row.since, label)
  }
}

/// The elapsed time, drawn by the phone from the start: no per-minute push.
private struct Elapsed: View {
  let since: Int
  var body: some View {
    if since > 0 {
      Text(timerInterval: Date(timeIntervalSince1970: TimeInterval(since))...Date.distantFuture, countsDown: false)
        .monospacedDigit()
        // the interval has no end, so the text would take every point it is offered: a fixed width leaves the label its room
        .frame(width: 64, alignment: .trailing)
    }
  }
}

private struct RowView: View {
  let kind: String
  let since: Int
  let label: String
  var body: some View {
    HStack(spacing: 8) {
      Circle().fill(kind == "needs" ? amber : Color.secondary).frame(width: 8, height: 8)
      Text(label).font(.subheadline).lineLimit(1)
      Spacer(minLength: 8)
      Elapsed(since: since).font(.footnote).foregroundColor(.secondary)
    }
  }
}

private struct LockScreenCard: View {
  let state: ActivityState
  let stale: Bool
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Text("M").font(.caption.bold()).frame(width: 22, height: 22).background(amber.opacity(0.25)).cornerRadius(6)
        Text(stale ? "Computer offline" : ActivityText.headline(state)).font(.headline)
      }
      if stale {
        Text("Updates when it is back").font(.subheadline).foregroundColor(.secondary)
      } else {
        ForEach(shownRows(state), id: \.id) { row in RowView(kind: row.kind, since: row.since, label: row.label) }
        Text(ActivityText.footer(state)).font(.footnote).foregroundColor(.secondary)
      }
    }
    .padding()
    .widgetURL(openURL)
  }
}

struct MoPilotLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: MoPilotActivityAttributes.self) { context in
      LockScreenCard(state: context.state, stale: context.isStale)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.center) {
          VStack(alignment: .leading, spacing: 4) {
            Text(context.isStale ? "Computer offline" : ActivityText.headline(context.state)).font(.footnote.bold())
            if context.isStale {
              Text("Updates when it is back").font(.footnote).foregroundColor(.secondary)
            } else {
              ForEach(shownRows(context.state), id: \.id) { row in RowView(kind: row.kind, since: row.since, label: row.label) }
            }
          }
        }
        DynamicIslandExpandedRegion(.bottom) { Link("Open MoPilot", destination: openURL).font(.footnote) }
      } compactLeading: {
        Text("M").font(.caption.bold())
      } compactTrailing: {
        // a number and a colour: the colour is never the only signal
        Text(ActivityText.islandCount(context.state)).foregroundColor(context.state.needs > 0 ? amber : .secondary)
      } minimal: {
        Text(ActivityText.islandCount(context.state)).foregroundColor(context.state.needs > 0 ? amber : .secondary)
      }
      .widgetURL(openURL)
    }
  }
}
