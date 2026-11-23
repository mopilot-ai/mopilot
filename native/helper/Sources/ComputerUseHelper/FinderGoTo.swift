import AppKit
import ApplicationServices
import Foundation
import HelperCore
import UniformTypeIdentifiers

// app.filePanel in Finder, which has no Save or Open panel: its Go › Go to Folder… sheet (identifiers GoToWindow and
// PathTextField, the same as a file panel's) takes the folder, or a file in it, which Finder then selects. The menu
// item is pressed and the path written through accessibility, so Finder stays in the background; when the sheet
// doesn't take the path that way, the brief-foreground rung (when main allows it) presses Return with Finder in front.

let finderBundleId = "com.apple.finder"

private func role(_ e: AXUIElement) -> String { axString(e, kAXRoleAttribute) ?? "" }
private func identifier(_ e: AXUIElement) -> String? { axString(e, "AXIdentifier") }

/// Finder's open Go to Folder sheet: its path field and the window it hangs on (or is).
private func finderGoToSheet(pid: pid_t) -> (field: AXUIElement, window: AXUIElement)? {
    let windows = (axAttr(appElement(pid), kAXWindowsAttribute) as? [AXUIElement]) ?? []
    for w in windows {
        let sheets = identifier(w) == goToSheetIdentifier ? [w] : axChildren(w).filter { role($0) == "AXSheet" && identifier($0) == goToSheetIdentifier }
        for s in sheets { if let f = axChildren(s).first(where: { identifier($0) == goToFieldIdentifier }) { return (f, w) } }
    }
    return nil
}

/// Finder's Go to Folder… menu item, found by its ⇧⌘G shortcut in any top-level menu (the menus may be in any language).
private func goToFolderItem(pid: pid_t) -> AXUIElement? {
    guard let bar = axElementAttr(appElement(pid), kAXMenuBarAttribute) else { return nil }
    for top in axChildren(bar) {
        for menu in axChildren(top) where role(menu) == "AXMenu" {
            if let item = axChildren(menu).first(where: { isGoToFolderShortcut(char: axString($0, "AXMenuItemCmdChar"), modifiers: whole(axAttr($0, "AXMenuItemCmdModifiers"))) }) {
                return item
            }
        }
    }
    return nil
}

extension Helper {
    func finderGoTo(_ scope: inout AppScope, _ params: [String: Any], folder: String, fileName: String?, hop: Int = 0) throws -> Any {
        let pid = scope.pid
        let path = goToPath(folder: folder, fileName: fileName)
        if finderGoToSheet(pid: pid) == nil {
            guard let item = goToFolderItem(pid: pid) else {
                throw HelperError.unsupported("go_to_folder", "Finder's Go › Go to Folder… isn't in its menu bar")
            }
            if axString(item, kAXEnabledAttribute) == "0" {
                throw HelperError.unsupported("go_to_folder", "Finder's Go to Folder… is disabled: open a Finder window first (app_menu [\"File\", \"New Finder Window\"]), then call this again")
            }
            _ = AXUIElementPerformAction(item, kAXPressAction as CFString)
        }
        guard let sheet = poll(2000, { finderGoToSheet(pid: pid) }) else {
            throw HelperError.unsupported("go_to_folder", "Finder's Go to Folder sheet didn't open")
        }
        // with no Finder window, Go to Folder is a window of its own that takes a folder but not a file: the folder
        // first, which opens a Finder window, then the file from that window's own Go to Folder sheet
        // (one hop: if Finder's Go to Folder is a window of its own again, the file is left for the caller to pick)
        if fileName != nil, hop == 0, identifier(sheet.window) == goToSheetIdentifier {
            let first = try finderGoTo(&scope, params, folder: folder, fileName: nil, hop: 1) as? [String: Any] ?? [:]
            guard first["reached"] as? Bool == true else { return first }
            return try finderGoTo(&scope, params, folder: folder, fileName: fileName, hop: 1)
        }
        guard axSetString(sheet.field, kAXValueAttribute, path) else {
            throw HelperError.unsupported("not_settable", "Finder's Go to Folder field doesn't take a path")
        }
        var out: [String: Any] = ["ok": true, "route": "ax", "finder": true]
        let closed = { gone(sheet.field) || finderGoToSheet(pid: pid) == nil }
        _ = AXUIElementSetAttributeValue(sheet.field, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        _ = AXUIElementPerformAction(sheet.field, "AXConfirm" as CFString)
        if poll(1500, { closed() ? true : nil }) == nil {
            // the sheet didn't take the path in the background: Return, with Finder briefly in front
            guard params["foreground"] as? Bool == true else {
                throw HelperError.unsupported("needs_foreground", "Finder's Go to Folder takes the path only while Finder is in front; brief switching to the app is off or not allowed for it")
            }
            // the Go to Folder window (or the Finder window its sheet is on) comes forward, with the path field focused
            var fgParams = params
            fgParams["windowId"] = scope.windows().first { $0.ax.map { CFEqual($0, sheet.window) } ?? false }.map { Int($0.listed.id) }
            let fg = try withBriefForeground(&scope, fgParams) { _ -> Any in
                guard frontmostPid() == pid, !closed() else { return ["route": "foreground"] }
                _ = AXUIElementSetAttributeValue(sheet.window, kAXMainAttribute as CFString, kCFBooleanTrue)
                _ = AXUIElementPerformAction(sheet.window, kAXRaiseAction as CFString)
                _ = AXUIElementSetAttributeValue(sheet.field, kAXFocusedAttribute as CFString, kCFBooleanTrue)
                usleep(120_000)
                // Return only into the Go to Folder field: in a Finder window it would start renaming the selection
                let focused = axElementAttr(appElement(pid), kAXFocusedUIElementAttribute)
                guard frontmostPid() == pid, !closed(), focused.map({ CFEqual($0, sheet.field) }) == true else { return ["route": "foreground"] }
                press("return")
                return ["route": "foreground"]
            }
            if let fg = fg as? [String: Any] { out.merge(fg) { _, b in b } }
            guard poll(2000, { closed() ? true : nil }) != nil else {
                if let close = finderGoToSheet(pid: pid).flatMap({ s in axChildren(axElementAttr(s.field, kAXParentAttribute) ?? s.window).first { identifier($0) == "CloseButton" } }) {
                    _ = AXUIElementPerformAction(close, kAXPressAction as CFString)
                }
                out["reached"] = false
                out["message"] = "Finder didn't go to \(path); check that it exists"
                return out
            }
        }
        // a Finder window now shows the folder, its title the folder's name: the window the sheet was on, or (when Go to
        // Folder was a window of its own) the one Finder opened, which is in front of its windows
        scope.invalidate()
        let shown = gone(sheet.window) ? ((axAttr(appElement(pid), kAXWindowsAttribute) as? [AXUIElement]) ?? []).first : sheet.window
        let title = shown.flatMap { axString($0, kAXTitleAttribute) } ?? ""
        out["location"] = title
        out["reached"] = panelShowsFolder([title], folder: folder, displayName: FileManager.default.displayName(atPath: folder))
        if let shown, let w = scope.windows().first(where: { $0.ax.map { CFEqual($0, shown) } ?? false }) { out["panelWindowId"] = Int(w.listed.id) }
        if let fileName { out["fileName"] = fileName }
        if let fileName, params["confirm"] as? Bool == true, out["reached"] as? Bool == true {
            out.merge(finderOpen(goToPath(folder: folder, fileName: fileName), name: fileName, granted: params["openGranted"] as? [String] ?? [])) { _, b in b }
        }
        return out
    }

    /// Finder's confirm: the selected file opens with its default app, as a double-click would, with that app left in
    /// the background. Documents only (finderOpenRefusal), only in an app the chat was granted (`granted`, bundle ids),
    /// and never in an app on the deny list.
    private func finderOpen(_ path: String, name: String, granted: [String]) -> [String: Any] {
        let url = URL(fileURLWithPath: path)
        guard let v = try? url.resourceValues(forKeys: [.isDirectoryKey, .isPackageKey, .isAliasFileKey, .isSymbolicLinkKey, .typeIdentifierKey]) else {
            return ["confirmed": false, "confirmMessage": "“\(name)” isn't in that folder"]
        }
        let type = v.typeIdentifier.flatMap { UTType($0) }
        let conforms = Set([type?.identifier].compactMap { $0 } + (type?.supertypes.map(\.identifier) ?? []))
        if let why = finderOpenRefusal(isDirectory: v.isDirectory == true || v.isPackage == true, isAlias: v.isAliasFile == true || v.isSymbolicLink == true,
                                       isExecutable: FileManager.default.isExecutableFile(atPath: path), conforms: conforms) {
            return ["confirmed": false, "confirmMessage": "“\(name)” wasn't opened: \(why)"]
        }
        guard let appURL = NSWorkspace.shared.urlForApplication(toOpen: url) else {
            return ["confirmed": false, "confirmMessage": "no app on this Mac opens “\(name)”"]
        }
        let bundleId = Bundle(url: appURL)?.bundleIdentifier
        let appName = FileManager.default.displayName(atPath: appURL.path).replacingOccurrences(of: ".app", with: "")
        if policy.denyList.rule(for: bundleId) != nil {
            return ["confirmed": false, "confirmMessage": "“\(name)” opens in \(appName), which computer use never controls"]
        }
        guard let bundleId, granted.contains(where: { $0.caseInsensitiveCompare(bundleId) == .orderedSame }) else {
            return ["confirmed": false, "confirmMessage": "“\(name)” opens in \(appName), which this chat hasn't been granted; request access to \(appName) first"]
        }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = false
        let done = DispatchSemaphore(value: 0)
        var failure: Error?
        NSWorkspace.shared.open([url], withApplicationAt: appURL, configuration: config) { _, error in
            failure = error
            done.signal()
        }
        guard done.wait(timeout: .now() + 10) == .success, failure == nil else {
            return ["confirmed": false, "confirmMessage": "“\(name)” didn't open in \(appName)"]
        }
        return ["confirmed": true, "pressed": "Open", "closed": true, "opened": appName, "openedBundleId": bundleId]
    }
}
