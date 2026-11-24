import AppKit
import ApplicationServices
import Foundation
import HelperCore
import ScreenCaptureKit

// App-scoped (background) control: the app.* requests behind the desktop_app_* tools. One window of one
// app is captured with ScreenCaptureKit's desktop-independent window filter (it works while the window
// is covered, on another Space or minimized) and acted in through accessibility first, then through
// events posted to the app's own process (CGEvent.postToPid). The app is never activated, the user's
// pointer never moves, and nothing here posts global (HID) events: what the background route can't do
// is refused as unsupported(<reason>). The one exception is the brief-foreground rung main asks for
// (`foreground: true`, withBriefForeground) after background input did nothing. Only public APIs are used.

private func num(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }
func whole(_ v: Any?) -> Int? { (v as? NSNumber)?.intValue }

/// The accessibility window behind each window id, kept between calls (re-found when it goes stale).
private let cacheLock = NSLock()
private var axWindowCache: [CGWindowID: AXUIElement] = [:]
/// Apps whose Chromium accessibility tree was switched on.
private var axEnabledPids = Set<pid_t>()

private let pressableRoles: Set<String> = [
    "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXLink", "AXMenuItem", "AXTab",
    "AXDisclosureTriangle", "AXIncrementor", "AXSlider", "AXCell", "AXRow", "AXSwitch", "AXToolbarButton",
]
private let allowedActions: Set<String> = ["AXPress", "AXIncrement", "AXDecrement", "AXConfirm", "AXCancel", "AXShowMenu", "AXRaise", "AXPick"]

// MARK: - Accessibility helpers

func axAttr(_ e: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
}

func axElementAttr(_ e: AXUIElement, _ name: String) -> AXUIElement? {
    guard let v = axAttr(e, name), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
    return (v as! AXUIElement)
}

func axChildren(_ e: AXUIElement) -> [AXUIElement] {
    (axAttr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

private func axBool(_ e: AXUIElement, _ name: String) -> Bool { axString(e, name) == "1" }

func axActions(_ e: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(e, &names) == .success, let list = names as? [String] else { return [] }
    return list
}

private func axSettable(_ e: AXUIElement, _ name: String) -> Bool {
    var ok = DarwinBoolean(false)
    return AXUIElementIsAttributeSettable(e, name as CFString, &ok) == .success && ok.boolValue
}

private func axRange(_ e: AXUIElement) -> CFRange? {
    guard let v = axAttr(e, kAXSelectedTextRangeAttribute), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var r = CFRange()
    return AXValueGetValue(v as! AXValue, .cfRange, &r) ? r : nil
}

private func axSetRange(_ e: AXUIElement, _ location: Int, _ length: Int) -> Bool {
    var r = CFRange(location: location, length: length)
    guard let v = AXValueCreate(.cfRange, &r) else { return false }
    return AXUIElementSetAttributeValue(e, kAXSelectedTextRangeAttribute as CFString, v) == .success
}

func axSetString(_ e: AXUIElement, _ name: String, _ s: String) -> Bool {
    AXUIElementSetAttributeValue(e, name as CFString, s as CFString) == .success
}

func axValueString(_ e: AXUIElement) -> String? {
    axAttr(e, kAXValueAttribute) as? String
}

func appElement(_ pid: pid_t) -> AXUIElement {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 1.0)
    return app
}

/// Chromium-based apps build their tree only when asked: AXManualAccessibility (Electron), and
/// AXEnhancedUserInterface for the rest of the family. Once per app process.
func enableAccessibility(pid: pid_t, app: NSRunningApplication) {
    cacheLock.lock()
    let first = axEnabledPids.insert(pid).inserted
    cacheLock.unlock()
    guard first else { return }
    let el = appElement(pid)
    let manual = AXUIElementSetAttributeValue(el, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success
    var frameworks: [String] = []
    if let url = app.bundleURL?.appendingPathComponent("Contents/Frameworks") {
        frameworks = (try? FileManager.default.contentsOfDirectory(atPath: url.path)) ?? []
    }
    if isChromiumBased(frameworks: frameworks) {
        if !manual { _ = AXUIElementSetAttributeValue(el, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue) }
        // the renderer builds its tree asynchronously
        usleep(250_000)
    }
}

// MARK: - Windows

struct AppWindow {
    let listed: ListedWindow
    let ax: AXUIElement?
    let minimized: Bool
    let main: Bool
    let auxiliary: Bool
    let state: WindowState

    var json: [String: Any] {
        [
            "window_id": Int(listed.id), "title": listed.title.isEmpty ? (ax.flatMap { axString($0, kAXTitleAttribute) } ?? "") : listed.title,
            "is_main": main, "is_minimized": state == .minimized, "is_hidden": state == .appHidden, "is_off_space": state == .offSpace,
            "is_auxiliary": auxiliary, "state": state.rawValue,
            "bounds": ["x": Double(listed.bounds.minX), "y": Double(listed.bounds.minY), "width": Double(listed.bounds.width), "height": Double(listed.bounds.height)],
        ]
    }
}

private func serverWindows(pid: pid_t) -> [ListedWindow] {
    guard let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
    return list.compactMap { w in
        guard (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
              let id = (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
              let b = w[kCGWindowBounds as String] as? NSDictionary, let rect = CGRect(dictionaryRepresentation: b) else { return nil }
        return ListedWindow(id: id, title: w[kCGWindowName as String] as? String ?? "", bounds: rect,
                            layer: (w[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0, alpha: (w[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1,
                            onScreen: (w[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false)
    }
}

/// The app's windows a person has (on screen, minimized, on another Space, or hidden with the app),
/// each matched to its accessibility window.
func appWindows(pid: pid_t, app: NSRunningApplication) -> [AppWindow] {
    let axs = (axAttr(appElement(pid), kAXWindowsAttribute) as? [AXUIElement]) ?? []
    let cands = axs.map { AXWindowCandidate(frame: axFrameOf($0), title: axString($0, kAXTitleAttribute)) }
    var used = Set<Int>(), sheets = SheetPool(axs)
    var out: [AppWindow] = []
    let hidden = app.isHidden
    for w in listableWindows(serverWindows(pid: pid)) {
        var idx = matchAXWindow(bounds: w.bounds, title: w.title, candidates: cands)
        if let i = idx { if used.contains(i) { idx = nil } else { used.insert(i) } }
        let ax = idx.map { axs[$0] } ?? sheets.take(bounds: w.bounds)
        guard keepWindow(onScreen: w.onScreen, axMatched: ax != nil, appHidden: hidden) else { continue }
        let minimized = ax.map { axBool($0, kAXMinimizedAttribute) } ?? false
        let subrole = ax.flatMap { axString($0, kAXSubroleAttribute) }
        let auxiliary = w.layer != 0 || ax == nil || (subrole != nil && subrole != "AXStandardWindow") || ax.flatMap { axString($0, kAXRoleAttribute) } == "AXSheet"
        out.append(AppWindow(listed: w, ax: ax, minimized: minimized, main: ax.map { axBool($0, kAXMainAttribute) } ?? false, auxiliary: auxiliary,
                             state: windowState(isOnScreen: w.onScreen, isMinimized: minimized, appHidden: hidden)))
    }
    // no window says it is main (the app is in the background): the first regular one stands in
    if !out.contains(where: \.main), let i = out.firstIndex(where: { !$0.auxiliary }) ?? out.indices.first {
        let w = out[i]
        out[i] = AppWindow(listed: w.listed, ax: w.ax, minimized: w.minimized, main: true, auxiliary: w.auxiliary, state: w.state)
    }
    cacheLock.lock()
    for w in out { if let ax = w.ax { axWindowCache[CGWindowID(w.listed.id)] = ax } }
    cacheLock.unlock()
    return out
}

/// One gated request: the app, checked once (permission, deny list, grant), and its windows, listed
/// once and listed again only when an action changed them. A batch shares one scope across its steps.
struct AppScope {
    let pid: pid_t
    let app: NSRunningApplication
    let info: [String: Any]
    private var cached: [AppWindow]?

    init(pid: pid_t, app: NSRunningApplication, info: [String: Any]) {
        self.pid = pid
        self.app = app
        self.info = info
    }

    mutating func windows() -> [AppWindow] {
        if let cached { return cached }
        let w = appWindows(pid: pid, app: app)
        cached = w
        return w
    }

    /// An action opened, closed or moved a window: list them again before the next one.
    mutating func invalidate() { cached = nil }
}

/// The window a request names (`windowId`), or the app's main window.
func pickWindow(_ scope: inout AppScope, _ params: [String: Any]) throws -> AppWindow {
    let windows = scope.windows()
    if let id = whole(params["windowId"]) {
        guard let w = windows.first(where: { Int($0.listed.id) == id }) else { throw HelperError.windowGone }
        return w
    }
    guard let w = windows.first(where: \.main) else { throw HelperError(9, "no_windows", "the app has no window") }
    return w
}

// MARK: - Element tree

/// A depth- and size-bounded snapshot of one window's accessibility tree ("0" is the window, "0.3.1" its
/// fourth child's second child). Password fields never carry a value.
private func windowTree(_ root: AXUIElement, maxDepth: Int, maxNodes: Int) -> [String: Any] {
    var count = 0
    var truncated = false
    func walk(_ e: AXUIElement, _ path: String, _ depth: Int) -> [String: Any]? {
        if count >= maxNodes { truncated = true; return nil }
        count += 1
        var node: [String: Any] = ["id": path]
        let role = axString(e, kAXRoleAttribute)
        let subrole = axString(e, kAXSubroleAttribute)
        if let role { node["role"] = role }
        if let subrole { node["subrole"] = subrole }
        for (key, attr) in [("title", kAXTitleAttribute), ("description", kAXDescriptionAttribute), ("help", kAXHelpAttribute), ("placeholder", "AXPlaceholderValue"), ("identifier", "AXIdentifier")] {
            if let s = axString(e, attr), !s.isEmpty { node[key] = String(s.prefix(200)) }
        }
        let secure = isSecureText(role: role, subrole: subrole)
        if secure { node["secure"] = true } else if let v = axString(e, kAXValueAttribute), !v.isEmpty { node["value"] = String(v.prefix(valueLimit(role: role))) }
        if let f = axFrameOf(e) { node["frame"] = ["x": Double(f.minX), "y": Double(f.minY), "w": Double(f.width), "h": Double(f.height)] }
        if axBool(e, kAXFocusedAttribute) { node["focused"] = true }
        if axString(e, kAXEnabledAttribute) == "0" { node["enabled"] = false }
        if axBool(e, kAXSelectedAttribute) { node["selected"] = true }
        if let role, pressableRoles.contains(role) || textRoles.contains(role) {
            let actions = axActions(e).filter { allowedActions.contains($0) }
            if !actions.isEmpty { node["actions"] = actions }
            if textRoles.contains(role) { node["settable"] = axSettable(e, kAXValueAttribute) }
        }
        if depth < maxDepth {
            var children: [[String: Any]] = []
            for (i, k) in axChildren(e).enumerated() {
                guard let c = walk(k, "\(path).\(i)", depth + 1) else { break }
                children.append(c)
            }
            if !children.isEmpty { node["children"] = children }
        } else {
            truncated = true
        }
        return node
    }
    let root = walk(root, "0", 0) ?? [:]
    return ["root": root, "nodes": count, "truncated": truncated]
}

/// The element an id names in the window now, if it is still there.
private func element(in window: AXUIElement, path: String) -> AXUIElement? {
    let parts = path.split(separator: ".").map { Int($0) }
    guard parts.first == 0, !parts.contains(where: { $0 == nil }) else { return nil }
    var e = window
    for i in parts.dropFirst() {
        let kids = axChildren(e)
        guard let i, i >= 0, i < kids.count else { return nil }
        e = kids[i]
    }
    return e
}

/// The app's own focused element (not the system-wide one: the app is in the background).
private func focusedElement(pid: pid_t) -> AXUIElement? {
    axElementAttr(appElement(pid), kAXFocusedUIElementAttribute)
}

private func screenLocked() -> Bool {
    (CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? Bool ?? false
}

// MARK: - Capture

private struct WindowShot {
    let image: CGImage
    let frame: WindowFrame
}

/// ScreenCaptureKit's window objects, kept for the small verification captures (listing shareable content
/// is the slow part of a capture). Screenshots the model sees always list it again: their frame must be current.
private var scWindowCache: [CGWindowID: SCWindow] = [:]

private func cachedSCWindow(_ id: CGWindowID, set: SCWindow? = nil) -> SCWindow? {
    cacheLock.lock()
    defer { cacheLock.unlock() }
    if let set { scWindowCache[id] = set }
    return scWindowCache[id]
}

private func shareableWindow(_ id: CGWindowID, cached: Bool) async throws -> SCWindow {
    if cached, let w = cachedSCWindow(id) { return w }
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
    guard let w = content.windows.first(where: { $0.windowID == id }) else { throw NoWindowsToCapture() }
    _ = cachedSCWindow(id, set: w)
    return w
}

/// One window's pixels, whatever covers it and wherever it is. `region` (window points) crops at full density.
private func captureWindow(_ id: CGWindowID, maxSide: Int, maxPixels: Int?, imageScale: Double, region: CGRect?, regionMaxSide: Int, cached: Bool = false) async throws -> WindowShot {
    let w = try await shareableWindow(id, cached: cached)
    let filter = SCContentFilter(desktopIndependentWindow: w)
    let scale = Double(filter.pointPixelScale)
    let frame = WindowFrame.forWindow(bounds: w.frame, scale: scale, maxSide: maxSide, maxPixels: maxPixels)
    let cfg = SCStreamConfiguration()
    cfg.showsCursor = false; cfg.ignoreShadowsSingleWindow = true
    if let region {
        let r = region.intersection(CGRect(origin: .zero, size: w.frame.size))
        guard !r.isNull, r.width >= 1, r.height >= 1 else { throw HelperError.invalidParams("region is outside the window") }
        cfg.sourceRect = r
        let s = captureSize(widthPoints: Double(r.width), heightPoints: Double(r.height), scale: scale, maxSide: regionMaxSide)
        cfg.width = s.width
        cfg.height = s.height
    } else {
        let k = max(0.1, min(imageScale, 1))
        cfg.width = max(1, Int((Double(frame.width) * k).rounded()))
        cfg.height = max(1, Int((Double(frame.height) * k).rounded()))
    }
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
    if region == nil { holdShot(ShotKey(windowId: Int(id), maxSide: maxSide, maxPixels: maxPixels, scale: imageScale), image: image, frame: frame) }
    return WindowShot(image: image, frame: frame)
}

/// Runs async work from the work queue and waits for it.
private func waitFor<T>(_ body: @escaping () async throws -> T) throws -> T {
    let done = DispatchSemaphore(value: 0)
    let box = ResultBox<T>()
    Task.detached {
        do { box.result = .success(try await body()) } catch { box.result = .failure(error) }
        done.signal()
    }
    done.wait()
    return try box.result!.get()
}

// MARK: - Verification

/// Milliseconds on the monotonic clock.
func nowMs() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000 }

/// The image averaged into a 24x24 grayscale grid (drawn at 48x48, then box-averaged).
private func grayGrid(_ image: CGImage) -> PixelGrid? {
    let side = 48
    var buf = [UInt8](repeating: 0, count: side * side)
    let ok = buf.withUnsafeMutableBytes { raw -> Bool in
        guard let ctx = CGContext(data: raw.baseAddress, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side,
                                  space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
        ctx.interpolationQuality = .medium
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
        return true
    }
    return ok ? PixelGrid.downsample(gray: buf, width: side, height: side, columns: 24, rows: 24) : nil
}

/// A small capture of the window for verification (and the chat's live thumbnail): nil without Screen
/// Recording or when the capture fails; verification then rests on accessibility alone.
private func smallCapture(_ id: CGWindowID) -> CGImage? {
    guard CGPreflightScreenCaptureAccess() else { return nil }
    return try? waitFor { try await captureWindow(id, maxSide: 256, maxPixels: nil, imageScale: 1, region: nil, regionMaxSide: 256, cached: true) }.image
}

/// The focused element, as one comparable string.
private func focusSignature(pid: pid_t) -> String? {
    guard let f = focusedElement(pid: pid) else { return nil }
    let frame = axFrameOf(f).map { "\(Int($0.minX)),\(Int($0.minY)),\(Int($0.width)),\(Int($0.height))" } ?? ""
    return [axString(f, kAXRoleAttribute) ?? "", frame, axString(f, kAXTitleAttribute) ?? ""].joined(separator: "|")
}

/// An element's state, as one comparable string (a password field's value is never read).
private func elementSignature(_ e: AXUIElement) -> String {
    let role = axString(e, kAXRoleAttribute)
    let secure = isSecureText(role: role, subrole: axString(e, kAXSubroleAttribute))
    let value = secure ? String((axValueString(e) ?? "").count) : String((axString(e, kAXValueAttribute) ?? "").prefix(2000))
    let range = axRange(e).map { "\($0.location):\($0.length)" } ?? ""
    return [role ?? "", value, range, axString(e, kAXSelectedAttribute) ?? "", axString(e, kAXEnabledAttribute) ?? "", axString(e, kAXTitleAttribute) ?? "", axString(e, kAXExpandedAttribute) ?? ""].joined(separator: "|")
}

/// What the helper can see of the app around one window: its on-screen windows, the window's bounds,
/// the focused element, the targeted element's state, an attached sheet, and (with `pixels`) a small image.
private func probe(pid: pid_t, window w: AppWindow, element el: AXUIElement?, pixels: Bool) -> (EffectProbe, CGImage?) {
    let listed = listableWindows(serverWindows(pid: pid))
    let image = pixels ? smallCapture(CGWindowID(w.listed.id)) : nil
    let sheet = w.ax.map { axChildren($0).contains { axString($0, kAXRoleAttribute) == "AXSheet" } }
    let p = EffectProbe(windows: listed.filter { $0.onScreen || $0.id == w.listed.id }.map(\.id), bounds: listed.first { $0.id == w.listed.id }?.bounds,
                        focused: focusSignature(pid: pid), element: el.map(elementSignature), sheet: sheet, grid: image.flatMap(grayGrid))
    return (p, image)
}

/// What the settle loop compares between samples: the accessibility signature, and the pixels within a tolerance.
private struct SettleKey: Equatable {
    let signature: String
    let grid: PixelGrid?

    static func == (a: SettleKey, b: SettleKey) -> Bool {
        guard a.signature == b.signature else { return false }
        guard let x = a.grid, let y = b.grid else { return a.grid == nil && b.grid == nil }
        return x.changedCells(y, threshold: 12) == 0
    }
}

/// Requests that act: verified when asked (`verify`), against the window they act in.
private let verifiedMethods: Set<String> = ["app.press", "app.click", "app.setText", "app.key", "app.scroll", "app.drag", "app.focus"]
/// What an app.batch step may be.
private let batchMethods: Set<String> = ["app.press", "app.click", "app.setText", "app.key", "app.scroll", "app.drag", "app.focus", "app.screenshot"]

/// Batches app.cancel stopped (by batchId); a batch checks before each step.
private var cancelledBatches = Set<String>()

func cancelAppBatch(_ id: String) {
    cacheLock.lock()
    cancelledBatches.insert(id)
    cacheLock.unlock()
}

private func batchCancelled(_ id: String?) -> Bool {
    guard let id else { return false }
    cacheLock.lock()
    defer { cacheLock.unlock() }
    return cancelledBatches.contains(id)
}

private func forgetBatch(_ id: String?) {
    guard let id else { return }
    cacheLock.lock()
    cancelledBatches.remove(id)
    cacheLock.unlock()
}

private func thumbnailJSON(_ image: CGImage?) -> String? {
    guard let image, let data = try? encodeImage(image, jpeg: true, quality: 0.6) else { return nil }
    return data.base64EncodedString()
}

/// screen.settle (the display-scope desktop_batch before its closing screenshot): waits until the
/// on-screen windows and the frontmost app's focused element stop changing, up to `capMs`, instead of a
/// fixed sleep. A short floor first, since the batch's events are handled asynchronously.
func settleScreen(_ params: [String: Any]) -> [String: Any] {
    let cap = min(max(num(params["capMs"]) ?? 400, 0), 3000)
    let policy = SettlePolicy(minMs: min(num(params["minMs"]) ?? 80, cap), quietMs: num(params["quietMs"]) ?? 100, capMs: cap)
    let outcome = settle(policy, now: nowMs, sleep: { usleep(useconds_t(max(0, $0) * 1000)) }) { () -> String in
        let windows = onScreenWindows().filter { $0.layer < mainMenuWindowLevel }.map { "\($0.pid):\(Int($0.bounds.minX)),\(Int($0.bounds.minY)),\(Int($0.bounds.width)),\(Int($0.bounds.height))" }
        return windows.joined(separator: ";") + "#" + (frontmostPid().flatMap { focusSignature(pid: $0) } ?? "")
    }
    return outcome.json.merging(["samples": outcome.samples]) { a, _ in a }
}

/// The request's point moved with its window.
private func shifted(_ params: [String: Any], _ d: (dx: Double, dy: Double)) -> [String: Any] {
    guard let x = num(params["x"]), let y = num(params["y"]) else { return params }
    return params.merging(["x": x + d.dx, "y": y + d.dy]) { _, b in b }
}

/// Says so in the result when the window had moved since the screenshot and the point moved with it.
private func movedNote(_ out: [String: Any], _ d: (dx: Double, dy: Double)) -> [String: Any] {
    guard d.dx != 0 || d.dy != 0 else { return out }
    return out.merging(["moved": ["dx": d.dx, "dy": d.dy]]) { _, b in b }
}

/// The image scaled down so its longer side is at most `maxSide` pixels (as is when already smaller).
private func scaledImage(_ image: CGImage, maxSide: Int) -> CGImage? {
    let k = min(1, Double(maxSide) / Double(max(image.width, image.height, 1)))
    if k >= 1 { return image }
    let w = max(1, Int(Double(image.width) * k)), h = max(1, Int(Double(image.height) * k))
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    ctx.interpolationQuality = .medium
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    return ctx.makeImage()
}

/// A rect a request passes ({x, y, width, height}).
private func rect(_ v: Any?) -> CGRect? {
    guard let r = v as? [String: Any], let x = num(r["x"]), let y = num(r["y"]), let w = num(r["width"]), let h = num(r["height"]) else { return nil }
    return CGRect(x: x, y: y, width: w, height: h)
}

// MARK: - Requests

extension Helper {
    /// The app a request names by `pid`: running, not MoPilot or the deny list, one of `bundleIds`.
    private func appTarget(_ params: [String: Any]) throws -> (pid_t, NSRunningApplication) {
        guard let p = whole(params["pid"]), p > 0 else { throw HelperError.invalidParams("pid") }
        let pid = pid_t(p)
        guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else { throw HelperError.notRunning }
        let t = Target(pid: pid, bundleId: app.bundleIdentifier, name: app.localizedName)
        if case .refused(let why) = policy.check([t]) { throw HelperError.refused(why) }
        if case .refused(let why) = restrict([t], to: params["bundleIds"] as? [String]) { throw HelperError.refused(why) }
        return (pid, app)
    }

    /// The window's accessibility element, required for an accessibility action.
    func windowAX(_ w: AppWindow) throws -> AXUIElement {
        if let ax = w.ax { return ax }
        cacheLock.lock()
        let cached = axWindowCache[CGWindowID(w.listed.id)]
        cacheLock.unlock()
        guard let cached else { throw HelperError.unsupported("no_accessibility", "this window has no accessibility elements; use coordinates") }
        return cached
    }

    /// The element a request names: `id` in the window, or (focused) the app's focused element.
    private func targetElement(pid: pid_t, window: AppWindow, _ params: [String: Any]) throws -> AXUIElement {
        if params["focused"] as? Bool == true {
            guard let f = focusedElement(pid: pid) else { throw HelperError.unsupported("no_focus", "the app has no focused element") }
            return f
        }
        guard let id = params["id"] as? String else { throw HelperError.invalidParams("id or focused is required") }
        guard let el = element(in: try windowAX(window), path: id) else { throw HelperError.elementGone(id) }
        // ids are child-index paths: after the UI changed, the same path can name another control
        if let now = elementMismatch(params["expectElement"] as? [String: Any], role: axString(el, kAXRoleAttribute),
                                     title: axString(el, kAXTitleAttribute), description: axString(el, kAXDescriptionAttribute)) {
            throw HelperError.elementChanged(id, now: now)
        }
        return el
    }

    /// Posted events only reach a window on the current Space; anything else needs app_bring_to_current_space.
    func requirePostable(_ w: AppWindow) throws {
        guard acceptsPostedEvents(w.state) else {
            throw HelperError.unsupported(w.state.rawValue, "the window is \(w.state == .offSpace ? "on another Space" : w.state == .minimized ? "minimized" : "hidden with its app"), so input can't reach it in the background; call app_bring_to_current_space first, or use element_index (accessibility works there)")
        }
    }

    private func point(_ params: [String: Any], in w: AppWindow) throws -> CGPoint {
        guard let x = num(params["x"]), let y = num(params["y"]) else { throw HelperError.invalidParams("x and y are required") }
        let p = CGPoint(x: x, y: y)
        guard w.listed.bounds.insetBy(dx: -1, dy: -1).contains(p) else { throw HelperError.invalidParams("the point is outside the window") }
        return p
    }

    /// Before an event is posted at a point: the window must have the size it had in the screenshot the
    /// point came from (`expectBounds`; a window that only moved takes the point with it), and no other
    /// window of the app that blocks input (a dialog, a sheet, a panel) may cover the point; another of its
    /// document windows may, since the events name the target window. Returns the offset applied, if any.
    private func checkDispatch(_ params: [String: Any], window w: AppWindow, scope: inout AppScope) throws -> (dx: Double, dy: Double) {
        var d = (dx: 0.0, dy: 0.0)
        switch checkBounds(expected: rect(params["expectBounds"]), current: w.listed.bounds) {
        case .resized: throw HelperError.windowChanged
        case .moved(let dx, let dy): d = (dx, dy)
        case .same: break
        }
        if let x = num(params["x"]), let y = num(params["y"]),
           case .ownWindow(let cover) = occlusion(at: CGPoint(x: x + d.dx, y: y + d.dy), pid: scope.pid, targetBounds: w.listed.bounds, stack: onScreenWindows(), ignore: [getpid()]),
           blocksInput(cover: cover, documentWindows: scope.windows().filter { !$0.auxiliary }.map(\.listed.bounds)) {
            throw HelperError.occluded
        }
        return d
    }

    /// The checks every app.* request passes once: Accessibility, and the app (running, allowed, granted).
    private func gate(_ params: [String: Any]) throws -> AppScope {
        guard AXIsProcessTrusted() else { throw HelperError.permission(.accessibility) }
        let (pid, app) = try appTarget(params)
        let info: [String: Any] = ["pid": Int(pid), "bundleId": app.bundleIdentifier ?? "", "name": app.localizedName ?? "", "hidden": app.isHidden, "frontmost": frontmostPid() == pid]
        return AppScope(pid: pid, app: app, info: info)
    }

    func runAppScoped(_ method: String, _ params: [String: Any]) throws -> Any {
        if method == "app.batch" { return try appBatch(params) }
        var scope = try gate(params)
        if params["foreground"] as? Bool == true || (params["ifFrontmost"] as? Bool == true && scope.info["frontmost"] as? Bool == true), briefForegroundMethods.contains(method) {
            return try withBriefForeground(&scope, params) { try self.foregroundStep(method, params.merging(["foreground": true]) { _, n in n }, &$0) }
        }
        return try performVerified(method, params, &scope)
    }

    /// The escalation rung after background input did nothing (main asks with `foreground: true`, or `ifFrontmost` for an app in front, which events posted to its process do not reach): the
    /// frontmost app and the pointer are noted, the target app is brought to the front (accessibility's
    /// AXFrontmost, then NSRunningApplication.activate; a window on another Space brings its Space), the
    /// action runs as usual, and the previous app and pointer come back. Refused while the user is using
    /// the mouse or keyboard; when they touch them during the action nothing is restored behind their
    /// back and the result says so. Public APIs only.
    func withBriefForeground(_ scope: inout AppScope, _ params: [String: Any], _ body: (inout AppScope) throws -> Any) throws -> Any {
        if screenLocked() { throw HelperError.refused("the locked screen") }
        let anyInput = CGEventType(rawValue: ~0)!
        let idle = guardTap.userIdle(hidIdle: CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: anyInput))
        guard briefForegroundMayStart(userIdleSeconds: idle) else {
            throw HelperError.unsupported("user_active", "the user is using the mouse or keyboard; the app wasn't brought forward")
        }
        let pid = scope.pid
        let previous = frontmostPid()
        let pointerBefore = CGEvent(source: nil)?.location
        let started = nowMs()
        var activated = previous == pid
        if !activated {
            _ = AXUIElementSetAttributeValue(appElement(pid), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
            let app = scope.app
            _ = DispatchQueue.main.sync { app.activate() }
            for _ in 0..<30 where frontmostPid() != pid { usleep(20_000) }
            activated = frontmostPid() == pid
        }
        // the window's state (another Space, the window order) changed with the activation
        scope.invalidate()
        if activated, let w = try? pickWindow(&scope, params), let ax = w.ax {
            _ = AXUIElementPerformAction(ax, kAXRaiseAction as CFString)
            usleep(60_000)
        }
        let restore = { () -> ForegroundRestore in
            let elapsed = (nowMs() - started) / 1000
            let acted = userActedDuring(elapsedSeconds: elapsed, userIdleSeconds: self.guardTap.userIdle(hidIdle: CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: anyInput)))
            let plan = planForegroundRestore(previousFront: previous, target: pid, pointerBefore: pointerBefore, pointerAfter: CGEvent(source: nil)?.location, userActed: acted)
            if let back = plan.activatePid {
                _ = AXUIElementSetAttributeValue(appElement(back), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
                if let prev = NSRunningApplication(processIdentifier: back) { _ = DispatchQueue.main.sync { prev.activate() } }
            }
            if let p = plan.pointer { CGWarpMouseCursorPosition(p) }
            return plan
        }
        let out: Any
        do { out = try body(&scope) } catch {
            _ = restore()
            throw error
        }
        let plan = restore()
        guard var dict = out as? [String: Any] else { return out }
        dict["foreground"] = ["activated": activated, "restored": !plan.userTookOver, "userTookOver": plan.userTookOver]
        return dict
    }

    /// app.batch: several steps against one app, gated once; each step is verified and settled as its
    /// own request would be. Stops at the first failure, or when app.cancel names the batch.
    private func appBatch(_ params: [String: Any]) throws -> Any {
        let steps = try batchSteps(params["steps"], allowed: batchMethods)
        let batchId = params["batchId"] as? String
        defer { forgetBatch(batchId) }
        let run = runBatch(steps, gate: { try self.gate(params) }, cancelled: { batchCancelled(batchId) }) { method, p, scope in
            var q = p
            q["pid"] = params["pid"]
            q["bundleIds"] = params["bundleIds"]
            if q["windowId"] == nil, let w = params["windowId"] { q["windowId"] = w }
            return try self.performVerified(method, q, &scope) as? [String: Any] ?? [:]
        }
        return run.json
    }

    /// A request, verified when it asks: the window and element are probed before it, the app is given
    /// time to settle (adaptive, up to `settleCapMs`), probed again, and the difference decides the effect.
    func performVerified(_ method: String, _ params: [String: Any], _ scope: inout AppScope) throws -> Any {
        guard params["verify"] as? Bool == true, verifiedMethods.contains(method) else { return try performAppScoped(method, params, &scope) }
        let w = try pickWindow(&scope, params)
        let pid = scope.pid
        let el: AXUIElement? = params["id"] is String || params["focused"] as? Bool == true ? (try? targetElement(pid: pid, window: w, params)) : focusedElement(pid: pid)
        let pixels = params["verifyPixels"] as? Bool != false
        let (before, _) = probe(pid: pid, window: w, element: el, pixels: pixels)
        guard var out = try performAppScoped(method, params, &scope) as? [String: Any] else { return [:] }
        let route = out["route"] as? String ?? "pid"
        let pollPixels = pixels && route != "ax"
        var last: (EffectProbe, CGImage?) = (before, nil)
        let outcome = settle(SettlePolicy.forRoute(route, capMs: num(params["settleCapMs"])), now: nowMs, sleep: { usleep(useconds_t(max(0, $0) * 1000)) }) { () -> SettleKey in
            last = probe(pid: pid, window: w, element: el, pixels: pollPixels)
            return SettleKey(signature: last.0.signature, grid: last.0.grid)
        }
        if pixels && last.1 == nil { last = probe(pid: pid, window: w, element: el, pixels: true) }
        let verdict = verifyEffect(before: before, after: last.0)
        var v = verdict.json.merging(outcome.json) { a, _ in a }
        if let a = before.grid, let b = last.0.grid { v["hash"] = [a.hashHex, b.hashHex] }
        out["verify"] = v
        if params["thumbnail"] as? Bool == true, let t = thumbnailJSON(last.1) { out["thumb"] = t }
        if verdict.evidence.contains(where: { ["window_opened", "window_closed", "window_moved", "sheet_appeared", "sheet_closed"].contains($0) }) { scope.invalidate() }
        return out
    }

    private func performAppScoped(_ method: String, _ params: [String: Any], _ scope: inout AppScope) throws -> Any {
        let pid = scope.pid, app = scope.app, appInfo = scope.info
        switch method {
        case "app.windows":
            enableAccessibility(pid: pid, app: app)
            scope.invalidate()
            return ["app": appInfo, "windows": scope.windows().map(\.json)]

        case "app.screenshot", "app.zoom":
            guard CGPreflightScreenCaptureAccess() else { throw HelperError.permission(.screenRecording) }
            enableAccessibility(pid: pid, app: app)
            // the frame the model's coordinates will be of: the window's bounds now, not as a batch first listed them
            scope.invalidate()
            let w = try pickWindow(&scope, params)
            var region: CGRect?
            if method == "app.zoom" {
                guard let r = params["region"] as? [String: Any], let x = num(r["x"]), let y = num(r["y"]), let rw = num(r["width"]), let rh = num(r["height"]) else {
                    throw HelperError.invalidParams("region")
                }
                region = CGRect(x: x, y: y, width: rw, height: rh)
            }
            let maxSide = cappedSide(whole(params["maxSide"]), fallback: 1568)
            let id = CGWindowID(w.listed.id)
            let shot = try waitFor {
                try await retryingCapture {
                    try await captureWindow(id, maxSide: maxSide, maxPixels: whole(params["maxPixels"]), imageScale: num(params["scale"]) ?? 1, region: region,
                                            regionMaxSide: cappedSide(whole(params["regionMaxSide"]), fallback: 2000))
                }
            }
            let jpeg = (params["format"] as? String) == "jpeg"
            let data = try encodeImage(shot.image, jpeg: jpeg, quality: num(params["quality"]) ?? 0.8)
            var out: [String: Any] = [
                jpeg ? "jpeg" : "png": data.base64EncodedString(), "mimeType": jpeg ? "image/jpeg" : "image/png",
                "width": shot.image.width, "height": shot.image.height,
                "frame": ["width": shot.frame.width, "height": shot.frame.height], "pixelsPerPoint": shot.frame.pixelsPerPoint,
                "window": w.json, "app": appInfo,
            ]
            if method == "app.screenshot", params["tree"] as? Bool != false, let ax = w.ax {
                out["tree"] = windowTree(ax, maxDepth: min(whole(params["maxDepth"]) ?? 25, 40), maxNodes: min(whole(params["maxNodes"]) ?? 2000, 4000))
            }
            // the chat's live thumbnail, from the same capture
            if params["thumbnail"] as? Bool == true, let small = scaledImage(shot.image, maxSide: 256), let t = thumbnailJSON(small) { out["thumb"] = t }
            return out

        case "app.press":
            let w = try pickWindow(&scope, params)
            let el = try targetElement(pid: pid, window: w, params)
            let action = params["action"] as? String ?? "AXPress"
            guard allowedActions.contains(action) else { throw HelperError.invalidParams("action") }
            if action == "AXPress", let role = axString(el, kAXRoleAttribute), menuPresentingRoles.contains(role) {
                throw HelperError.unsupported("menu", "this control opens a menu, which would bring the app to the front; use app_menu for the menu bar command instead, or app_file_panel for the folder of a Save or Open panel")
            }
            let actions = axActions(el)
            let frame = axFrameOf(el)
            let center = frame.map { ["x": Double($0.midX), "y": Double($0.midY)] } ?? [:]
            let ok = actions.contains(action) && AXUIElementPerformAction(el, action as CFString) == .success
            if ok { signalClick(params["signal"] as? String); return ["ok": true, "route": "ax", "action": action, "center": center] }
            // the element can't be pressed: a click at the point the caller names (or the element's center),
            // in the same request, so a batch doesn't need a round trip for it
            if let fb = params["fallbackClick"] as? [String: Any] {
                var q = params.merging(fb) { _, b in b }
                if q["x"] == nil, let f = frame {
                    q["x"] = Double(f.midX)
                    q["y"] = Double(f.midY)
                }
                guard q["x"] != nil else { throw HelperError.unsupported("no_press", "the focused element has no press action and no position; target it by coordinate or element_index") }
                guard var clicked = try performAppScoped("app.click", q, &scope) as? [String: Any] else { return [:] }
                clicked["fallback"] = true
                return clicked
            }
            guard actions.contains(action) else { return ["ok": false, "action": action, "center": center, "actions": actions.filter { allowedActions.contains($0) }] }
            return ["ok": false, "route": "ax", "action": action, "center": center]

        case "app.focus":
            if frontmostPid() == pid { throw HelperError.unsupported("frontmost", "the user is working in this app; app_click the field instead") }
            let w = try pickWindow(&scope, params)
            let el = try targetElement(pid: pid, window: w, params)
            if isSecureText(role: axString(el, kAXRoleAttribute), subrole: axString(el, kAXSubroleAttribute)) { throw HelperError.refused("a password field") }
            if isInsideSheet(el) { throw HelperError.unsupported("sheet", "the element is inside a dialog sheet") }
            _ = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            let now = focusedElement(pid: pid)
            return ["ok": true, "route": "ax", "moved": now.map { CFEqual($0, el) } ?? false]

        case "app.setText":
            return try setText(&scope, params)

        case "app.key":
            return try key(&scope, params)

        case "app.click":
            let w = try pickWindow(&scope, params)
            try requirePostable(w)
            let d = try checkDispatch(params, window: w, scope: &scope)
            let p = try point(shifted(params, d), in: w)
            guard let flags = parseModifiers(params["modifiers"] as? String ?? "") else { throw HelperError.invalidParams("unknown modifier") }
            let click = routedClick(pid: pid, windowId: CGWindowID(w.listed.id), at: p, button: params["button"] as? String ?? "left", count: whole(params["count"]) ?? 1, flags: flags, foreground: params["foreground"] as? Bool == true, signal: params["signal"] as? String)
            return movedNote(click, d)

        case "app.drag":
            let w = try pickWindow(&scope, params)
            try requirePostable(w)
            guard let raw = params["points"] as? [[Any]], (2...20).contains(raw.count) else { throw HelperError.invalidParams("points: 2 to 20 [x, y] pairs") }
            var points: [CGPoint] = []
            for pair in raw {
                guard pair.count == 2, let x = num(pair[0]), let y = num(pair[1]) else { throw HelperError.invalidParams("points: [x, y] pairs") }
                points.append(CGPoint(x: x, y: y))
            }
            var check = params
            check["x"] = Double(points[0].x)
            check["y"] = Double(points[0].y)
            let d = try checkDispatch(check, window: w, scope: &scope)
            points = try points.map { try point(["x": $0.x + d.dx, "y": $0.y + d.dy], in: w) }
            appDrag(pid: pid, windowId: CGWindowID(w.listed.id), through: points)
            return movedNote(["ok": true, "route": "pid"], d)

        case "app.scroll":
            let w = try pickWindow(&scope, params)
            let dy = num(params["dy"]) ?? 0
            // the scroll bar of the scroll area holding the element: no pointer, no wheel
            if params["id"] is String, let el = try? targetElement(pid: pid, window: w, params) {
                var cur: AXUIElement? = el
                for _ in 0..<30 {
                    guard let c = cur else { break }
                    if axString(c, kAXRoleAttribute) == "AXScrollArea", let bar = axElementAttr(c, kAXVerticalScrollBarAttribute),
                       let v = axAttr(bar, kAXValueAttribute) as? NSNumber, axSettable(bar, kAXValueAttribute) {
                        let next = scrolledValue(current: v.doubleValue, units: dy)
                        let ok = AXUIElementSetAttributeValue(bar, kAXValueAttribute as CFString, NSNumber(value: next)) == .success
                        if ok { return ["ok": true, "route": "ax", "value": next, "saturated": next == 0 || next == 1] }
                        break
                    }
                    cur = axElementAttr(c, kAXParentAttribute)
                }
            }
            try requirePostable(w)
            let d = try checkDispatch(params, window: w, scope: &scope)
            let p = try point(shifted(params, d), in: w)
            let wheel = routedWheel(pid: pid, windowId: CGWindowID(w.listed.id), at: p, lines: Int32(clamping: Int((-dy * 3).rounded())), foreground: params["foreground"] as? Bool == true)
            return movedNote(wheel, d)

        case "app.filePanel":
            return try filePanel(&scope, params)
        case "app.menu":
            return try menu(pid: pid, params)

        case "app.menuRefresh":
            return try refreshMenu(pid: pid, params)

        case "app.bringToCurrentSpace":
            if screenLocked() { throw HelperError.refused("the locked screen") }
            let w = try pickWindow(&scope, params)
            switch w.state {
            case .visible:
                return ["ok": true, "state": "visible", "changed": false]
            case .appHidden:
                // unhide doesn't activate: the windows come back behind the one the user works in
                _ = DispatchQueue.main.sync { app.unhide() }
                return ["ok": true, "state": "visible", "changed": true]
            case .minimized:
                let ax = try windowAX(w)
                let ok = AXUIElementSetAttributeValue(ax, kAXMinimizedAttribute as CFString, kCFBooleanFalse) == .success
                if !ok { throw HelperError.unsupported("minimized", "the app didn't take the window out of the Dock") }
                return ["ok": true, "state": "visible", "changed": true]
            case .offSpace:
                throw HelperError.unsupported("off_space", "macOS has no public way to move another app's window between Spaces; element_index actions (accessibility) and app_menu still work there, or the user can switch to that Space")
            }

        default:
            throw HelperError.methodNotFound(method)
        }
    }

    /// Writes text: AXSelectedText at the caret first, then (when that fails) the whole value only if the
    /// field is empty or replacing it was allowed; keystrokes to the app's process only for its focused
    /// element when asked (a canvas app's own text cursor).
    private func setText(_ scope: inout AppScope, _ params: [String: Any]) throws -> Any {
        let pid = scope.pid
        guard let text = params["text"] as? String else { throw HelperError.invalidParams("text") }
        let w = try pickWindow(&scope, params)
        let el = try targetElement(pid: pid, window: w, params)
        let role = axString(el, kAXRoleAttribute)
        if isSecureText(role: role, subrole: axString(el, kAXSubroleAttribute)) { throw HelperError.refused("a password field") }
        let replace = (params["mode"] as? String) == "replace"
        let isText = role.map { textRoles.contains($0) } ?? false
        guard isText || axSettable(el, kAXSelectedTextAttribute) else {
            if params["allowKeys"] as? Bool == true {
                try requirePostable(w)
                let typed = appCharacters(pid: pid, windowId: CGWindowID(w.listed.id), text)
                return ["ok": true, "route": "pid", "typed": typed, "effect": "unverifiable"]
            }
            throw HelperError.unsupported("not_text", "\(role ?? "this element") isn't a text field; the text would land in whatever has keyboard focus")
        }
        let before = axValueString(el)
        if frontmostPid() != pid { _ = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue) }
        // the brief-foreground rung: the app is in front, so keystrokes to its focused field land like typing
        if params["typeKeys"] as? Bool == true, isText {
            _ = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            if replace, let b = before { _ = axSetRange(el, 0, (b as NSString).length) }
            try requirePostable(w)
            let typed = appCharacters(pid: pid, windowId: CGWindowID(w.listed.id), text)
            usleep(50_000)
            let ok = textWriteEffective(before: before, after: axValueString(el), text: text, replace: replace)
            return ["ok": true, "route": "pid", "typed": typed, "effect": ok ? "confirmed" : "unverifiable"]
        }
        if replace {
            let length = ((before ?? "") as NSString).length
            if axSetRange(el, 0, length), axSetString(el, kAXSelectedTextAttribute, text), textWriteEffective(before: before, after: axValueString(el), text: text, replace: true) {
                return ["ok": true, "route": "ax", "effect": "confirmed"]
            }
            guard axSetString(el, kAXValueAttribute, text) else { throw HelperError.unsupported("not_settable", "the app doesn't let its text be set in the background") }
            let ok = textWriteEffective(before: before, after: axValueString(el), text: text, replace: true)
            return ["ok": true, "route": "ax", "effect": ok ? "confirmed" : "ineffective"]
        }
        if axSetString(el, kAXSelectedTextAttribute, text) {
            let ok = textWriteEffective(before: before, after: axValueString(el), text: text, replace: false)
            return ["ok": true, "route": "ax", "effect": ok ? "confirmed" : "ineffective"]
        }
        switch textFallback(currentValue: before ?? "", overwriteExisting: params["overwrite"] as? Bool == true) {
        case .refuse:
            throw HelperError.unsupported("would_replace_content", "inserting at the caret doesn't work in this app and the field already has text; pass overwrite_existing: true to replace the whole field")
        case .setValue, .replaceAll:
            guard axSetString(el, kAXValueAttribute, text) else { throw HelperError.unsupported("not_settable", "the app doesn't let its text be set in the background") }
            var out: [String: Any] = ["ok": true, "route": "ax", "effect": textWriteEffective(before: before, after: axValueString(el), text: text, replace: true) ? "confirmed" : "ineffective"]
            if let before, !before.isEmpty { out["previous"] = String(before.prefix(500)) }
            return out
        }
    }

    /// A key: its accessibility meaning on the element when it has one, else a keystroke to the app's process.
    private func key(_ scope: inout AppScope, _ params: [String: Any]) throws -> Any {
        let pid = scope.pid
        guard let spec = params["combo"] as? String, !spec.isEmpty else { throw HelperError.invalidParams("combo") }
        let w = try pickWindow(&scope, params)
        let el = params["id"] != nil || params["focused"] as? Bool == true ? try targetElement(pid: pid, window: w, params) : focusedElement(pid: pid)
        if let el, let semantic = axKeySemantic(spec) {
            let role = axString(el, kAXRoleAttribute) ?? ""
            let actions = axActions(el)
            switch semantic {
            case .confirm where actions.contains("AXConfirm"):
                return ["ok": AXUIElementPerformAction(el, "AXConfirm" as CFString) == .success, "route": "ax", "action": "AXConfirm"]
            case .cancel where actions.contains("AXCancel"):
                return ["ok": AXUIElementPerformAction(el, "AXCancel" as CFString) == .success, "route": "ax", "action": "AXCancel"]
            case .deleteBackward, .deleteForward:
                if textRoles.contains(role), let range = axRange(el), let value = axValueString(el) {
                    guard let r = deletionRange(value: value, location: range.location, length: range.length, forward: semantic == .deleteForward) else {
                        return ["ok": true, "route": "ax", "effect": "confirmed", "note": "nothing to delete"]
                    }
                    if axSetRange(el, r.location, r.length), axSetString(el, kAXSelectedTextAttribute, "") {
                        return ["ok": true, "route": "ax", "effect": axValueString(el) != value ? "confirmed" : "ineffective"]
                    }
                }
            case .selectAll:
                if textRoles.contains(role), let value = axValueString(el) {
                    let ok = axSetRange(el, 0, (value as NSString).length)
                    return ["ok": ok, "route": "ax", "effect": ok ? "confirmed" : "ineffective"]
                }
                throw HelperError.unsupported("select_all", "an app in the background ignores cmd+a; app_type with mode: replace overwrites a field")
            default:
                break
            }
        } else if axKeySemantic(spec) == .selectAll {
            throw HelperError.unsupported("select_all", "an app in the background ignores cmd+a; app_type with mode: replace overwrites a field")
        }
        guard let combo = parseKeyCombo(keystrokeSpec(spec)) else { throw HelperError.invalidParams("unknown key") }
        if let el, isSecureText(role: axString(el, kAXRoleAttribute), subrole: axString(el, kAXSubroleAttribute)) { throw HelperError.refused("a password field") }
        try requirePostable(w)
        appKeystroke(pid: pid, windowId: CGWindowID(w.listed.id), combo)
        return ["ok": true, "route": "pid", "effect": "unverifiable"]
    }

    /// AppKit revalidates a menu (menuNeedsUpdate:, validateMenuItem: / validateUserInterfaceItem:) only when
    /// it opens, and a background app never opens its menus, so their enabled states and toggled titles
    /// ("Make Plain Text" / "Make Rich Text") go stale. This opens the top-level menu `menu` through
    /// accessibility (AXPress on its menu bar item: no pointer movement, no activation) and closes it at
    /// once (AXCancel), so AppKit runs its update pass; app.menu then reads current items. The menu can
    /// draw for a frame or two while open; nothing in it is chosen.
    func refreshMenu(pid: pid_t, _ params: [String: Any]) throws -> Any {
        guard let name = params["menu"] as? String else { throw HelperError.invalidParams("menu is required") }
        let app = appElement(pid)
        guard let bar = axElementAttr(app, kAXMenuBarAttribute) else {
            throw HelperError.unsupported("no_menu_bar", "the app has no menu bar it shows to accessibility")
        }
        let kids = axChildren(bar)
        guard let i = menuIndex(kids.map { axString($0, kAXTitleAttribute) }, matching: name) else {
            throw HelperError.invalidParams("no \"\(name)\" in the menu bar")
        }
        let item = kids[i]
        // AppKit may answer the press only once its menu tracking runs: don't hold the request for a second
        AXUIElementSetMessagingTimeout(item, 0.3)
        let pressed = AXUIElementPerformAction(item, kAXPressAction as CFString)
        func shown() -> AXUIElement? { axElementAttr(app, "AXShownMenuUIElement") }
        var open = shown()
        for _ in 0..<10 where open == nil && pressed != .success {
            usleep(10_000)
            open = shown()
        }
        let refreshed = pressed == .success || open != nil
        // close it: the shown menu, else the item's own AXMenu, then the item; until nothing is shown
        let menu = open ?? axChildren(item).first { axString($0, kAXRoleAttribute) == "AXMenu" }
        for _ in 0..<5 {
            if let menu { _ = AXUIElementPerformAction(menu, kAXCancelAction as CFString) }
            _ = AXUIElementPerformAction(item, kAXCancelAction as CFString)
            if shown() == nil { break }
            usleep(10_000)
        }
        return ["ok": true, "refreshed": refreshed, "menu": axString(item, kAXTitleAttribute) ?? name]
    }

    /// The menu bar, walked through accessibility: list a menu's items, or press the item a path names.
    /// Nothing opens on screen.
    private func menu(pid: pid_t, _ params: [String: Any]) throws -> Any {
        guard let bar = axElementAttr(appElement(pid), kAXMenuBarAttribute) else {
            throw HelperError.unsupported("no_menu_bar", "the app has no menu bar it shows to accessibility")
        }
        func items(_ e: AXUIElement) -> [AXUIElement] {
            // a menu bar item or a menu item with a submenu holds one AXMenu with the items
            let kids = axChildren(e)
            if let menu = kids.first(where: { axString($0, kAXRoleAttribute) == "AXMenu" }) { return axChildren(menu) }
            return axString(e, kAXRoleAttribute) == "AXMenuBar" ? kids : []
        }
        func walk(_ path: [String]) throws -> AXUIElement {
            var level = bar
            var walked: [String] = []
            for name in path {
                let kids = items(level)
                guard let i = menuIndex(kids.map { axString($0, kAXTitleAttribute) }, matching: name) else {
                    let shown = kids.compactMap { menuTitleForListing(axString($0, kAXTitleAttribute)) }.prefix(40).joined(separator: ", ")
                    throw HelperError.invalidParams("no \"\(name)\" in \(walked.isEmpty ? "the menu bar" : walked.joined(separator: " > ")); it has: \(shown)")
                }
                level = kids[i]
                walked.append(axString(level, kAXTitleAttribute) ?? name)
            }
            return level
        }
        if let path = params["path"] as? [String] {
            guard path.count >= 2 else { throw HelperError.unsupported("menu_title", "pressing a top-level menu would open it on screen; name an item inside it") }
            let leaf = try walk(path)
            if axString(leaf, kAXEnabledAttribute) == "0" { throw HelperError.menuDisabled(path) }
            if !items(leaf).isEmpty { throw HelperError.unsupported("submenu", "\(path.joined(separator: " > ")) is a submenu; list it and name an item inside") }
            let ok = AXUIElementPerformAction(leaf, kAXPressAction as CFString) == .success
            return ["ok": ok, "route": "ax", "pressed": path]
        }
        let path = params["list"] as? [String] ?? []
        let level = try walk(path)
        let list: [[String: Any]] = items(level).compactMap { e in
            guard let title = menuTitleForListing(axString(e, kAXTitleAttribute)) else { return nil }
            var o: [String: Any] = ["title": title]
            if axString(e, kAXEnabledAttribute) == "0" { o["enabled"] = false }
            if axString(e, kAXRoleAttribute) != "AXMenuBarItem", !items(e).isEmpty { o["submenu"] = true }
            if let s = menuShortcut(char: axString(e, "AXMenuItemCmdChar"), modifiers: whole(axAttr(e, "AXMenuItemCmdModifiers"))) { o["shortcut"] = s }
            if axString(e, "AXMenuItemMarkChar").map({ !$0.isEmpty }) == true { o["checked"] = true }
            return o
        }
        return ["ok": true, "path": path, "items": list]
    }
}
