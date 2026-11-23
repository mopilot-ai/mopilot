// The body a brief foreground runs (AppScoped.swift withBriefForeground): a menu press refreshes its top-level menu
// first, now that the app is active, so items it keeps disabled in the background (TextEdit's Export as PDF, #3571 G7)
// are validated before the press; every request then runs as it would in the background.
import Foundation
import HelperCore

extension Helper {
    func foregroundStep(_ method: String, _ params: [String: Any], _ scope: inout AppScope) throws -> Any {
        if let top = foregroundMenuRefresh(method, params) { _ = try? refreshMenu(pid: scope.pid, ["menu": top]) }
        return try performVerified(method, params, &scope)
    }
}
