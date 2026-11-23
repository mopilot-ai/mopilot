import Foundation

// Save and Open panels in the background (app.filePanel): the folder and name a request may send, which windows and
// which subtree of a window is the panel, the sidebar row a standard folder has, whether the panel shows the folder,
// what Go to Folder is given, and what pressing the panel's default button did.

/// The folder app.filePanel sends the panel to: an absolute path without control characters (a newline would end
/// the Go to Folder field's input early), at most 1024 characters; nil otherwise.
public func panelTargetPath(_ folder: String) -> String? {
    guard folder.hasPrefix("/"), folder.count <= 1024, !folder.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { return nil }
    return folder
}

/// A file name for a Save panel's name field: a name only (no folder), no control characters, not "." or "..".
public func validPanelFileName(_ name: String) -> Bool {
    !name.isEmpty && name.count <= 255 && !name.contains("/") && name != "." && name != ".."
        && !name.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 })
}

/// What app.filePanel reads of one element of a candidate panel.
public struct PanelElement: Equatable {
    public let role: String
    public let identifier: String?

    public init(role: String, identifier: String? = nil) {
        self.role = role
        self.identifier = identifier
    }
}

/// Accessibility identifiers of NSSavePanel / NSOpenPanel parts, as the open-and-save panel service gives them
/// (seen on macOS 26: the sheet "save-panel", the name field, the Where pop-up, the options triangle).
public let filePanelIdentifiers: Set<String> = ["save-panel", "open-panel", "saveAsNameTextField", "where popup", "NS_OPEN_SAVE_DISCLOSURE_TRIANGLE"]
/// A Save panel's name field ("Save As:").
public let saveAsFieldIdentifier = "saveAsNameTextField"
/// The Where pop-up: its value is the folder the panel shows.
public let wherePopupIdentifier = "where popup"
/// The Go to Folder sheet's path field.
public let goToFieldIdentifier = "PathTextField"
/// The Go to Folder sheet itself: a sheet on a file panel, or on a Finder window (Go › Go to Folder…).
public let goToSheetIdentifier = "GoToWindow"
/// A panel's default button (Save, Open, Export, Choose).
public let okButtonIdentifier = "OKButton"

/// The windows app.filePanel looks for a panel in, by window id: the one a request names first (when it is still
/// listed), then every other listed window. A panel is often a window of its own (TextEdit's Open panel, a sheet wider
/// than its document window), so naming the document window, or a window that has closed since, never hides it.
public func panelSearchOrder(named: Int?, listed: [Int]) -> [Int] {
    guard let named, listed.contains(named) else { return listed }
    return [named] + listed.filter { $0 != named }
}

/// What Go to Folder is given: the folder, or with a file name the file in it, which the panel (or Finder) selects.
public func goToPath(folder: String, fileName: String?) -> String {
    guard let fileName else { return folder }
    return folder == "/" ? "/" + fileName : folder + "/" + fileName
}

/// Whether a menu item's shortcut is Go to Folder's ⇧⌘G (AXMenuItemCmdModifiers 1 is Shift with Command), which
/// finds the item whatever language the menus are in.
public func isGoToFolderShortcut(char: String?, modifiers: Int?) -> Bool {
    char?.uppercased() == "G" && modifiers == 1
}

/// Type identifiers Finder's confirm may open with their default app: documents a person reads (text, PDF, images,
/// audio and video, office and iWork documents).
public let openableDocumentTypes: Set<String> = [
    "public.plain-text", "public.rtf", "com.adobe.pdf", "public.image", "public.audiovisual-content", "public.comma-separated-values-text",
    "net.daringfireball.markdown", "org.openxmlformats.wordprocessingml.document", "org.openxmlformats.spreadsheetml.sheet",
    "org.openxmlformats.presentationml.presentation", "com.microsoft.word.doc", "com.microsoft.excel.xls", "com.microsoft.powerpoint.ppt",
    "com.apple.iwork.pages.sffpages", "com.apple.iwork.numbers.sffnumbers", "com.apple.iwork.keynote.sffkey",
]
/// Type identifiers that run, install, import or load something when opened, even when they are also a document type
/// above (a script is plain text, an SVG an image, HTML text).
public let runnableTypes: Set<String> = [
    "public.executable", "com.apple.application", "com.apple.bundle", "public.script", "public.shell-script", "public.source-code",
    "com.apple.installer-package-archive", "com.apple.disk-image", "public.html", "public.svg-image", "public.xml",
    "com.apple.internet-location", "public.url", "com.apple.web-internet-location", "public.calendar-event", "public.vcard",
    "com.apple.mobileconfig", "com.apple.shortcut", "com.apple.automator-workflow", "com.apple.applescript.script",
]

/// Why Finder's confirm (opening the selected file with its default app, as a double-click would) refuses a file, or
/// nil when it may open it. `conforms` is every type identifier the file conforms to (its type and supertypes). A
/// document only: never a folder or package, an alias or link (it opens what it points to), anything executable, and
/// nothing of a type that runs or imports something.
public func finderOpenRefusal(isDirectory: Bool, isAlias: Bool, isExecutable: Bool, conforms: Set<String>) -> String? {
    if isDirectory { return "it is a folder or a package; go into it with folder instead" }
    if isAlias { return "it is an alias or a link; go to the file it points to instead" }
    if isExecutable || !conforms.isDisjoint(with: runnableTypes) { return "opening it would run or install something" }
    if conforms.isDisjoint(with: openableDocumentTypes) { return "only documents (text, PDF, images, media, office files) are opened this way" }
    return nil
}

/// What pressing a panel's default button did: the panel closed (the file was saved or opened), an alert came up on
/// it (Replace, a missing file) that the caller answers itself, or the panel is still open with nothing to answer.
public enum PanelConfirmOutcome: String {
    case closed, prompt, open
}

public func panelConfirmOutcome(panelGone: Bool, alertButtons: [String]) -> PanelConfirmOutcome {
    if panelGone { return .closed }
    return alertButtons.isEmpty ? .open : .prompt
}

/// Whether a sheet or dialog is a file panel: it carries one of the panel's identifiers, or failing those, the
/// panel's shape (a sidebar or file list, a location pop-up and buttons). A plain alert has neither.
public func looksLikeFilePanel(_ elements: [PanelElement]) -> Bool {
    if elements.contains(where: { $0.identifier.map(filePanelIdentifiers.contains) ?? false }) { return true }
    let roles = Set(elements.map(\.role))
    return roles.contains("AXPopUpButton") && roles.contains("AXButton") && (roles.contains("AXOutline") || roles.contains("AXBrowser"))
}

/// The panel's sidebar row for a standard folder (the home folder, its Desktop, Documents and Downloads, the
/// Applications folder, the startup disk), matched by the name Finder shows for it; nil for any other folder or
/// when the sidebar has no such row. Choosing a sidebar row works in the background; other folders need Go to Folder.
public func sidebarRow(for folder: String, home: String, displayName: String?, rows: [String]) -> Int? {
    let standard: Set<String> = [home, home + "/Desktop", home + "/Documents", home + "/Downloads", "/Applications", "/"]
    guard standard.contains(folder), let name = displayName?.lowercased(), !name.isEmpty else { return nil }
    return rows.firstIndex { $0.trimmingCharacters(in: .whitespaces).lowercased() == name }
}

/// Whether the panel shows the folder: its Where pop-up (or another pop-up of an Open panel) reads the folder's
/// display name (localized by Finder, e.g. "Macintosh HD" for "/") or its last path component. nil when the panel
/// shows no location to compare with.
public func panelShowsFolder(_ shown: [String], folder: String, displayName: String?) -> Bool? {
    let names = shown.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    guard !names.isEmpty else { return nil }
    let last = (folder as NSString).lastPathComponent
    let wanted = Set([displayName, last].compactMap { $0?.lowercased() }.filter { !$0.isEmpty })
    return names.contains { wanted.contains($0.lowercased()) }
}
