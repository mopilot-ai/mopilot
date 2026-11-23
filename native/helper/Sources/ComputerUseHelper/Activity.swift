// Computer History's activity sample (#1363): the frontmost app and, only for an app main says the user allowed, its focused window's title, whether a secure field has focus, and for an allowed browser the front page's address. Nothing else is read (no field values, no screenshots), and an app on the deny list is never read at all.
import AppKit
import ApplicationServices
import HelperCore

/// How far into a browser window the page's web area is looked for, and how many elements at most.
private let webAreaDepth = 10
private let webAreaNodes = 600
/// A title longer than this is cut here; main redacts and cuts it further.
private let titleChars = 1000

private func element(_ e: AXUIElement, _ name: String) -> AXUIElement? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success, let v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
    return (v as! AXUIElement)
}

private func children(_ e: AXUIElement) -> [AXUIElement] {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &v) == .success, let arr = v as? [AXUIElement] else { return [] }
    return arr
}

/// The address of the page a browser window shows: the AXURL of its first web area, breadth first.
private func webAreaURL(_ window: AXUIElement) -> String? {
    var queue: [(AXUIElement, Int)] = [(window, 0)]
    var seen = 0
    while !queue.isEmpty, seen < webAreaNodes {
        let (e, depth) = queue.removeFirst()
        seen += 1
        if axString(e, kAXRoleAttribute) == "AXWebArea" {
            var v: CFTypeRef?
            if AXUIElementCopyAttributeValue(e, kAXURLAttribute as CFString, &v) == .success, let url = v as? URL { return url.absoluteString }
        }
        if depth < webAreaDepth { queue.append(contentsOf: children(e).map { ($0, depth + 1) }) }
    }
    return nil
}

/// One sample. `allowed`: the bundle ids the user allowed; `browsers`: those of them whose page address is read.
func activitySample(allowed: Set<String>, browsers: Set<String>, deny: DenyList) -> [String: Any] {
    let front = DispatchQueue.main.sync { NSWorkspace.shared.frontmostApplication }
    guard let app = front, let id = app.bundleIdentifier, !id.isEmpty else { return ["bundleId": "", "secure": false] }
    // an app the user did not allow, or one on the deny list, is named by its bundle id and nothing else
    if deny.rule(for: id) != nil { return ["bundleId": id, "secure": false, "denied": true] }
    guard allowed.contains(id) else { return ["bundleId": id, "secure": false, "allowed": false] }
    var out: [String: Any] = ["bundleId": id, "name": app.localizedName ?? id, "secure": false]
    guard AXIsProcessTrusted() else {
        out["trusted"] = false
        return out
    }
    let el = AXUIElementCreateApplication(app.processIdentifier)
    // an app that hangs costs one second, not the six of the default timeout
    AXUIElementSetMessagingTimeout(el, 1.0)
    if browsers.contains(id) { enableAccessibility(pid: app.processIdentifier, app: app) }
    if let focused = element(el, kAXFocusedUIElementAttribute), isSecure(focused) {
        // nothing else is read while a password field has focus
        out["secure"] = true
        return out
    }
    guard let window = element(el, kAXFocusedWindowAttribute) else { return out }
    if let title = axString(window, kAXTitleAttribute) { out["title"] = String(title.prefix(titleChars)) }
    if browsers.contains(id), let url = webAreaURL(window) { out["url"] = url }
    return out
}

/// Runs Computer History's samples off the work queue, so an agent's batch never delays one and one never delays it,
/// and one at a time: while an app's hung accessibility keeps one running, the next is answered busy at once.
final class ActivitySampler {
    private let queue = DispatchQueue(label: "computer-use.activity")
    private let lock = NSLock()
    private var running = false

    /// `params`: `apps`, the bundle ids the user allowed; `browsers`, those whose page address is read.
    func sample(_ params: [String: Any], deny: DenyList, reply: @escaping ([String: Any]) -> Void) {
        let allowed = Set((params["apps"] as? [Any] ?? []).compactMap { $0 as? String })
        let browsers = Set((params["browsers"] as? [Any] ?? []).compactMap { $0 as? String }).intersection(allowed)
        lock.lock()
        let busy = running
        running = true
        lock.unlock()
        if busy { return reply(["bundleId": "", "secure": false, "busy": true]) }
        queue.async { [self] in
            let sample = activitySample(allowed: allowed, browsers: browsers, deny: deny)
            lock.lock()
            running = false
            lock.unlock()
            reply(sample)
        }
    }
}
