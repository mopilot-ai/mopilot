import AppKit
import ApplicationServices
import Foundation
import HelperCore

// app.filePanel: the folder (and file name) of an app's Save or Open panel. The panel is drawn by macOS's
// open-and-save panel service, whose accessibility tree is bridged into the app, but which takes keys and Go to
// Folder only while the app is active. So, in this order:
//   - the file name: written into the name field through accessibility (background);
//   - a standard folder (home, Desktop, Documents, Downloads, Applications, the startup disk): its sidebar row is
//     selected through accessibility (background);
//   - any other folder, when main allows the brief-foreground rung: the app comes to the front for a moment,
//     cmd+shift+g opens Go to Folder, the path is written into its field through accessibility and Return confirms,
//     then the previous app and pointer come back (withBriefForeground); refused otherwise.
// The panel stays open: pressing Save or Open is the caller's own, separate action.

/// Whether the element is inside a dialog sheet (app.focus refuses those).
func isInsideSheet(_ e: AXUIElement) -> Bool {
    var cur: AXUIElement? = e
    for _ in 0..<40 {
        guard let c = cur else { return false }
        if axString(c, kAXRoleAttribute) == "AXSheet" { return true }
        cur = axElementAttr(c, kAXParentAttribute)
    }
    return false
}

private func role(_ e: AXUIElement) -> String { axString(e, kAXRoleAttribute) ?? "" }

/// Sheets the window server lists as windows of their own (on macOS 26 a Save panel sheet wider than its document
/// window is one): their accessibility elements are children of the document windows, not among the app's AXWindows.
/// `take` hands out the sheet whose frame is a window's bounds, each sheet once, so its controls (Save, Replace) get
/// element indexes in that window. The sheets are read once per window listing, and only if a window needs one.
struct SheetPool {
    private let windows: [AXUIElement]
    private var sheets: [(sheet: AXUIElement, frame: CGRect?)]?

    init(_ windows: [AXUIElement]) { self.windows = windows }

    mutating func take(bounds: CGRect) -> AXUIElement? {
        let all = sheets ?? windows.flatMap { axChildren($0).filter { role($0) == "AXSheet" } }.map { ($0, axFrameOf($0)) }
        guard let i = matchAXWindow(bounds: bounds, title: nil, candidates: all.map { AXWindowCandidate(frame: $0.frame, title: nil) }) else {
            sheets = all
            return nil
        }
        sheets = all.enumerated().filter { $0.offset != i }.map(\.element)
        return all[i].sheet
    }
}
private func identifier(_ e: AXUIElement) -> String? { axString(e, "AXIdentifier") }

/// The element and its descendants, depth-first, at most `limit` of them.
private func subtree(_ root: AXUIElement, limit: Int = 3000) -> [AXUIElement] {
    var out: [AXUIElement] = []
    var stack = [root]
    while let e = stack.popLast(), out.count < limit {
        out.append(e)
        stack.append(contentsOf: axChildren(e).reversed())
    }
    return out
}

/// The Save or Open panel in a window: a sheet on it, or the window itself when it is the panel (a dialog). `byShape`
/// also accepts a sheet or dialog by the panel's shape (a walk of its tree); a plain window never counts by shape (Notes
/// or Mail have a sidebar, pop-ups and buttons too).
func findFilePanel(in window: AXUIElement, byShape: Bool) -> AXUIElement? {
    let candidates = axChildren(window).filter { role($0) == "AXSheet" } + [window]
    // the panel's own identifier ("save-panel") answers without walking its tree
    if let c = candidates.first(where: { identifier($0).map(filePanelIdentifiers.contains) ?? false }) { return c }
    guard byShape else { return nil }
    let dialog = ["AXDialog", "AXSystemDialog"].contains(axString(window, kAXSubroleAttribute) ?? "")
    return candidates.filter { role($0) == "AXSheet" || dialog }.first { c in
        looksLikeFilePanel(subtree(c).map { PanelElement(role: role($0), identifier: identifier($0)) })
    }
}


/// The panel's parts app.filePanel uses, found in one walk: every accessibility read crosses into the panel
/// service, so the tree is walked once and the parts are read directly afterwards.
private struct PanelParts {
    var nameField: AXUIElement?
    var wherePopup: AXUIElement?
    var okButton: AXUIElement?
    var popups: [AXUIElement] = []
    var rows: [(row: AXUIElement, name: String)] = []
    /// The items of the file list (column, list or icon view), by the name each shows.
    var items: [(item: AXUIElement, name: String)] = []

    init(_ panel: AXUIElement) {
        var lists: [(list: AXUIElement, role: String)] = []
        for e in subtree(panel) {
            let r = role(e)
            if r == "AXPopUpButton" { popups.append(e) }
            if r == "AXOutline", rows.isEmpty, axString(e, kAXDescriptionAttribute) == "sidebar" {
                rows = axChildren(e).filter { role($0) == "AXRow" }.map { row in
                    (row, subtree(row, limit: 20).first { role($0) == "AXStaticText" }.flatMap(axValueString) ?? "")
                }
                continue
            }
            if ["AXBrowser", "AXOutline", "AXList", "AXTable"].contains(r) { lists.append((e, r)) }
            if r == "AXButton", identifier(e) == okButtonIdentifier { okButton = e }
            guard r == "AXTextField" || r == "AXPopUpButton", let id = identifier(e) else { continue }
            if id == saveAsFieldIdentifier { nameField = e }
            if id == wherePopupIdentifier { wherePopup = e }
        }
        // the file list (column, list or icon view): the first browser, outline or table besides the sidebar, else a
        // list, read in a second walk of that list alone; in column view only the last column, the folder shown (a
        // parent column may hold a folder of the same name)
        let main = lists.firstIndex { $0.role != "AXList" }
        let column = main.flatMap { i in lists[i].role == "AXBrowser" ? lists[(i + 1)...].last { $0.role == "AXList" }?.list : nil }
        if let list = column ?? (main.map { lists[$0] } ?? lists.first)?.list {
            items = subtree(list).compactMap { e in
                let r = role(e)
                guard r == "AXTextField" || r == "AXStaticText", let v = axValueString(e), !v.isEmpty else { return nil }
                return (e, v)
            }
        }
    }

    /// What the panel shows as its location: the Where pop-up, else any pop-up (an Open panel's path pop-up).
    var shown: [String] { wherePopup.flatMap(axValueString).map { [$0] } ?? popups.compactMap(axValueString) }

    /// The file list's item with this name, when the list shows it.
    func item(named name: String) -> AXUIElement? {
        items.first { $0.name == name }?.item
    }
}

/// The window a panel lives in: the panel itself when it is a window (TextEdit's Open panel), else the window
/// its sheet hangs on.
private func panelWindow(_ panel: AXUIElement) -> AXUIElement {
    role(panel) == "AXWindow" ? panel : (axElementAttr(panel, kAXWindowAttribute) ?? axElementAttr(panel, kAXParentAttribute) ?? panel)
}

/// The Go to Folder sheet's path field: on a sheet of the panel, or of the window the panel lives in.
private func goToField(_ panel: AXUIElement) -> AXUIElement? {
    let hosts = [panel, panelWindow(panel)]
    return hosts.lazy.flatMap { axChildren($0).filter { role($0) == "AXSheet" } }.compactMap { axChildren($0).first { identifier($0) == goToFieldIdentifier } }.first
}

/// Whether an element is gone (its window closed): it answers no role any more.
func gone(_ e: AXUIElement) -> Bool { axString(e, kAXRoleAttribute) == nil }

/// An alert that came up on the panel after its default button (Replace, a missing file): its buttons and text.
private func alertOn(_ panel: AXUIElement) -> (buttons: [String], text: String)? {
    for host in [panel, panelWindow(panel)] {
        // not the panel itself (a Save sheet on its document window), Go to Folder, or another panel
        for sheet in axChildren(host) where role(sheet) == "AXSheet" && !CFEqual(sheet, panel) && identifier(sheet) != goToSheetIdentifier
            && !(identifier(sheet).map(filePanelIdentifiers.contains) ?? false) {
            let all = subtree(sheet, limit: 200)
            let buttons = all.filter { role($0) == "AXButton" }.compactMap { axString($0, kAXTitleAttribute) }.filter { !$0.isEmpty }
            guard !buttons.isEmpty else { continue }
            let text = all.filter { role($0) == "AXStaticText" }.compactMap(axValueString).joined(separator: " ")
            return (buttons, String(text.prefix(300)))
        }
    }
    return nil
}

/// Polls `body` every 50 ms for up to `ms` milliseconds.
func poll<T>(_ ms: Double, _ body: () -> T?) -> T? {
    let end = Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000 + ms
    repeat {
        if let v = body() { return v }
        usleep(50_000)
    } while Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000 < end
    return nil
}

func press(_ spec: String) {
    if let combo = parseKeyCombo(spec) { postKey(combo) }
}

extension Helper {
    /// The app's Save or Open panel wherever it is: a sheet on a window or a window of its own, in the window the
    /// request names first, then every other window the app has (listed or only in accessibility). When the named
    /// window is still there, another window counts only as a panel of its own (TextEdit's Open panel), never as a sheet
    /// on another document, so a Save never goes to another document's panel. A panel opened from a menu a moment ago may
    /// not be up yet, so this waits up to `waitMs` for one. Returns the panel and the id of the listed window it lives in.
    func locatePanel(_ scope: inout AppScope, named: Int?, waitMs: Double = 1500) -> (panel: AXUIElement, windowId: Int?)? {
        let end = nowMs() + waitMs
        while true {
            let windows = scope.windows()
            let namedAlive = named.map { n in windows.contains { Int($0.listed.id) == n } } ?? false
            var roots: [(AXUIElement, Int?)] = panelSearchOrder(named: named, listed: windows.map { Int($0.listed.id) }).compactMap { id in
                windows.first { Int($0.listed.id) == id }.flatMap { w in (try? self.windowAX(w)).map { ($0, id) } }
            }
            let axs = (axAttr(appElement(scope.pid), kAXWindowsAttribute) as? [AXUIElement]) ?? []
            for ax in axs where !roots.contains(where: { CFEqual($0.0, ax) }) { roots.append((ax, nil)) }
            // by identifier on every window first (cheap), then by shape
            for byShape in [false, true] {
                for (root, id) in roots {
                    guard let p = findFilePanel(in: root, byShape: byShape) else { continue }
                    if namedAlive, id != named, !(role(p) == "AXWindow" && CFEqual(p, root)) { continue }
                    return (p, id)
                }
            }
            guard nowMs() < end else { return nil }
            usleep(100_000)
            scope.invalidate()
        }
    }

    func filePanel(_ scope: inout AppScope, _ params: [String: Any]) throws -> Any {
        guard let raw = params["folder"] as? String, let folder = panelTargetPath(raw) else { throw HelperError.invalidParams("folder") }
        let name = params["fileName"] as? String
        if let name, !validPanelFileName(name) { throw HelperError.invalidParams("fileName") }
        let confirm = params["confirm"] as? Bool == true
        // Finder has no panels of its own: no wait for one to come up before its Go to Folder
        let finder = scope.app.bundleIdentifier == finderBundleId
        guard let found = locatePanel(&scope, named: whole(params["windowId"]), waitMs: finder ? 0 : 1500) else {
            if finder { return try finderGoTo(&scope, params, folder: folder, fileName: name) }
            throw HelperError.unsupported("no_file_panel", "\(scope.app.localizedName ?? "the app") has no Save or Open panel open; open one first (for example app_menu [\"File\", \"Open…\"] or [\"File\", \"Save…\"]), then call this again")
        }
        let (panel, host) = found
        // an alert already up on the panel (Replace) takes every key and click: report it rather than act under it
        if let alert = alertOn(panel) {
            var out = promptAnswer(alert, pressed: nil)
            out["ok"] = true
            if let host { out["panelWindowId"] = host }
            return out
        }
        var parts = PanelParts(panel)
        var out: [String: Any] = ["ok": true]
        // a Save panel takes the name in its field; an Open panel selects the file of that name
        let pick = name.flatMap { parts.nameField == nil ? $0 : nil }
        if let name, let field = parts.nameField {
            if axSetString(field, kAXValueAttribute, name) { out["fileName"] = axValueString(field) ?? name } else { out["nameField"] = false }
        }
        let display = FileManager.default.displayName(atPath: folder)
        let reached = { panelShowsFolder(parts.shown, folder: folder, displayName: display) }
        let rows = parts.rows
        // the panel's own window comes to the front for Go to Folder, not the document window the request named
        var fgParams = params
        fgParams["windowId"] = host
        let pid = scope.pid
        let goTo = { (scope: inout AppScope, path: String) throws in
            guard params["foreground"] as? Bool == true else {
                throw HelperError.unsupported("needs_foreground", "\(path) couldn't be chosen from the panel's sidebar or file list, and the panel takes Go to Folder only while its app is in front; brief switching to the app is off or not allowed for it")
            }
            if let fg = try self.withBriefForeground(&scope, fgParams, { _ in try self.goToFolder(panel, path, pid: pid) }) as? [String: Any] {
                out.merge(fg) { _, b in b }
            }
        }
        if pick == nil, reached() == true {
            out["route"] = "ax"
        } else if pick == nil, let i = sidebarRow(for: folder, home: NSHomeDirectory(), displayName: display, rows: rows.map(\.name)),
                  AXUIElementSetAttributeValue(rows[i].row, kAXSelectedAttribute as CFString, kCFBooleanTrue) == .success,
                  poll(1500, { reached() == true ? true : nil }) != nil {
            out["route"] = "ax"
        } else {
            // a file in an Open panel is chosen by Go to Folder with its path, which selects it: the list's selection is
            // neither readable nor settable through accessibility (macOS 26 column view)
            try goTo(&scope, goToPath(folder: folder, fileName: pick))
        }
        if let pick {
            // the file is in the list Go to Folder went to; pressing Open (confirm) then shows that it was the one chosen
            let listed = out["reached"] as? Bool != false && poll(1000, { PanelParts(panel).item(named: pick) != nil ? true : nil }) != nil
            out["selected"] = listed ? pick : false
            parts = PanelParts(panel)
        }
        scope.invalidate()
        // the window the panel's controls are listed in: the sheet's own window when the window server lists one
        if let own = scope.windows().first(where: { $0.ax.map { CFEqual($0, panel) } ?? false }) { out["panelWindowId"] = Int(own.listed.id) } else if let host { out["panelWindowId"] = host }
        if out["reached"] == nil, let r = reached() {
            out["reached"] = r
            out["location"] = parts.shown.first
        }
        if confirm { out.merge(confirmPanel(panel, parts, out)) { _, b in b } }
        return out
    }

    /// The confirm step: the panel's default button (Save, Open) pressed through accessibility, only once the panel
    /// shows the folder and, in an Open panel given a name, the file is selected. An alert that comes up (Replace, a
    /// missing file) is reported for the caller to answer itself; nothing in it is pressed.
    private func confirmPanel(_ panel: AXUIElement, _ parts: PanelParts, _ so: [String: Any]) -> [String: Any] {
        // pressed only on what was checked: the folder shown, the name written, the file in the list
        guard so["reached"] as? Bool == true, so["selected"] as? Bool != false, so["nameField"] as? Bool != false else {
            return ["confirmed": false, "confirmMessage": "not pressed: the panel doesn't show the folder, the name or the file it was asked for"]
        }
        // the panel's own default button, never one of the document window behind a sheet
        guard let ok = parts.okButton ?? axElementAttr(panel, kAXDefaultButtonAttribute) else {
            return ["confirmed": false, "confirmMessage": "the panel has no default button to press"]
        }
        let title = axString(ok, kAXTitleAttribute) ?? "OK"
        if axString(ok, kAXEnabledAttribute) == "0" {
            return ["confirmed": false, "confirmMessage": "\(title) is disabled: the panel has nothing chosen it can \(title.lowercased())"]
        }
        // the press can report an error and still have worked: a modal alert (Replace) holds the call until it times out
        let pressed = AXUIElementPerformAction(ok, kAXPressAction as CFString) == .success
        var alert: (buttons: [String], text: String)?
        _ = poll(2500) { () -> Bool? in
            if gone(panel) { return true }
            alert = alertOn(panel)
            return alert == nil ? nil : true
        }
        switch panelConfirmOutcome(panelGone: gone(panel), alertButtons: alert?.buttons ?? []) {
        case .closed:
            return ["confirmed": true, "pressed": title, "closed": true]
        case .prompt:
            return promptAnswer(alert, pressed: title)
        case .open:
            return pressed ? ["confirmed": true, "pressed": title, "closed": false] : ["confirmed": false, "confirmMessage": "\(title) didn't take the press, or the panel is slow to close; check with a screenshot before trying again"]
        }
    }

    /// An alert up on the panel (Replace): reported with its text and buttons, never answered.
    private func promptAnswer(_ alert: (buttons: [String], text: String)?, pressed: String?) -> [String: Any] {
        var out: [String: Any] = ["confirmed": pressed != nil, "closed": false, "prompt": alert?.text ?? "", "promptButtons": alert?.buttons ?? []]
        if let pressed { out["pressed"] = pressed } else { out["confirmMessage"] = "an alert is up in the panel" }
        return out
    }

    /// Inside the brief foreground: the panel's window is raised, cmd+shift+g opens Go to Folder, the path goes into
    /// its field, Return confirms. These are real key presses, so each one goes only while the app is still in front
    /// (the activation may have failed, or the user switched apps), and Return only while Go to Folder is still open:
    /// otherwise it would press the panel's default button (Save) after the user dismissed the sheet with Esc.
    private func goToFolder(_ panel: AXUIElement, _ folder: String, pid: pid_t) throws -> Any {
        let inFront = { frontmostPid() == pid }
        guard inFront() else { throw HelperError.unsupported("not_in_front", "the app didn't come to the front, so Go to Folder wasn't opened") }
        // the panel's window takes the keys, not a document window behind it
        let win = panelWindow(panel)
        _ = AXUIElementSetAttributeValue(win, kAXMainAttribute as CFString, kCFBooleanTrue)
        _ = AXUIElementPerformAction(win, kAXRaiseAction as CFString)
        usleep(80_000)
        guard inFront() else { throw HelperError.unsupported("not_in_front", "the app left the front before Go to Folder was opened; nothing was pressed") }
        press("cmd+shift+g")
        guard let field = poll(2000, { goToField(panel) }) else {
            throw HelperError.unsupported("go_to_folder", "the panel's Go to Folder field didn't open; this panel may not be a standard macOS one")
        }
        let open = { !gone(field) }
        guard axSetString(field, kAXValueAttribute, folder) else {
            if inFront() && open() { press("escape") }
            throw HelperError.unsupported("not_settable", "the Go to Folder field doesn't take a path")
        }
        usleep(150_000)
        guard inFront(), open() else {
            throw HelperError.unsupported("interrupted", "Go to Folder was closed or the app left the front before the folder was confirmed; nothing was pressed")
        }
        press("return")
        // the sheet closes when the panel took the folder; it stays (with an error) when the folder doesn't exist
        guard poll(2000, { open() ? nil : true }) != nil else {
            if inFront() && open() { press("escape") }
            return ["reached": false, "route": "foreground", "message": "the panel didn't go to \(folder); check that it exists"]
        }
        return ["route": "foreground"]
    }
}
