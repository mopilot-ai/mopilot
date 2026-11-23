// The Live Activity's attributes, compiled into the app (which starts the activity) and the widget (which draws it). ActivityKit pairs the two by this type, so the file is the same in both targets.
import ActivityKit

/// Fixed for the activity's life and empty: everything that changes is the content state (see ActivityState).
struct MoPilotActivityAttributes: ActivityAttributes {
  typealias ContentState = ActivityState
}
