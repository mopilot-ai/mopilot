// A reply's prose as one read-only UITextView, so iOS selects a range in place (handles, Look Up, Translate, Share) and the edit menu can carry the app's own entries (spike for #4837).
import ExpoModulesCore
import UIKit

public final class MoPilotSelectableTextModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MoPilotSelectableText")

    View(MoPilotSelectableTextView.self) {
      Events("onContentSize", "onLinkPress", "onMenuAction", "onMenuShown", "onSelect")

      // the run's styled stretches (see the view for their keys)
      Prop("runs") { (view: MoPilotSelectableTextView, runs: [[String: String]]) in
        view.runs = runs
      }
      // the app's own entries in the edit menu (empty: none)
      Prop("serif") { (view: MoPilotSelectableTextView, serif: Bool) in
        view.serif = serif
      }
      Prop("menuEntries") { (view: MoPilotSelectableTextView, entries: [[String: String]]) in
        view.menuEntries = entries
      }
    }
  }
}
