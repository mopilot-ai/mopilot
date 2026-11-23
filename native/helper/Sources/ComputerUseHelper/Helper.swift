import AppKit
import Foundation
import HelperCore

/// The JSON-RPC methods, and the controller state they share with the input guard.
final class Helper {
    let config: LaunchConfig
    let server: Server
    private let policyLock = NSLock()
    private var _policy: TargetPolicy
    /// The deny list can grow while the helper runs (`deny.set`); everything reads it through here.
    var policy: TargetPolicy {
        policyLock.lock(); defer { policyLock.unlock() }
        return _policy
    }
    let guardTap = InputGuard()
    /// The glow around the window being acted in (main thread).
    private let glow = GlowOverlay()
    /// The turns main revoked, and the token the desktop lock is held for (design D1).
    let turns = TurnGate()
    let lock = DesktopLock(path: (NSTemporaryDirectory() as NSString).appendingPathComponent("ai.mopilot.code.computer-use.lock"))

    /// Input, screenshots and AX reads run one at a time, in order.
    private let work = DispatchQueue(label: "computer-use.work")
    private let activity = ActivitySampler()
    private let recorder = WatchRecorder()
    private let state = NSLock()
    private var controlling = false
    private var paused: PauseReason?
    /** The user's clipboard while the desktop tools use it (main thread). */
    private var savedPasteboard: [[(NSPasteboard.PasteboardType, Data)]]?

    init(config: LaunchConfig, peerRequirement: String?) {
        self.config = config
        _policy = TargetPolicy(protectedPids: [config.mainPid, getpid()], denyList: DenyList(extra: config.denyBundleIds ?? []))
        server = Server(path: config.socket, expectedPid: config.mainPid, token: config.token, peerRequirement: peerRequirement)
        overlayOwnerPids = [config.mainPid]
    }

    func start() throws {
        server.handler = { [weak self] method, params, turn, reply in self?.dispatch(method, params, TurnToken(turn), reply) }
        server.onDisconnect = { [weak self] in self?.quit("main disconnected") }
        try server.start()

        guardTap.isActive = { [weak self] in self?.isActive ?? false }
        guardTap.onPause = { [weak self] reason, sourcePid in self?.pause(reason, sourcePid: sourcePid) }
        guardTap.ownEventAllowed = { [weak self] event in self?.ownEventAllowed(event) ?? false }
        guardTap.landsOnMoPilot = { [weak self] event in self?.landsOnMoPilot(event) ?? false }
        guardTap.protectedPids = { [weak self] in self?.policy.protectedPids ?? [] }
        recorder.policy = { [weak self] in self?.policy ?? TargetPolicy(protectedPids: [], denyList: DenyList(extra: [])) }
        recorder.notify = { [weak self] method, params in self?.server.notify(method, params) }; clickNotify = recorder.notify
        guardTap.onInput = { [recorder] type, event, physical in recorder.note(type, event, physical: physical) }
        // The tap needs Accessibility; keep trying until it's granted.
        if !guardTap.install() {
            Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] t in
                if self?.guardTap.install() ?? true { t.invalidate() }
            }
        }
    }

    func quit(_ why: String) {
        log("exiting: \(why)")
        // remove the guard tap now when already on the main thread; otherwise it goes with the process
        if Thread.isMainThread { guardTap.uninstall() }
        lock.release()
        server.stop()
        exit(0)
    }

    private var isActive: Bool {
        state.lock(); defer { state.unlock() }
        return controlling && paused == nil
    }

    private func pause(_ reason: PauseReason, sourcePid: Int64) {
        state.lock()
        let wasActive = controlling && paused == nil
        if wasActive { paused = reason }
        state.unlock()
        if wasActive { server.notify("control.paused", ["reason": reason.rawValue]) }
    }

    /// Runs on the main thread from the event tap.
    private func ownEventAllowed(_ event: CGEvent) -> Bool {
        if event.type == .keyDown {
            let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier
            return policy.check([Target(pid: pid, bundleId: pid.flatMap { bundleId(of: $0) })]) == .allowed
        }
        guard let owner = windowOwner(at: event.location) else { return true }
        return policy.check([owner]) == .allowed
    }

    /// Whether an event would reach a MoPilot window (keys go to the frontmost app). Main thread.
    private func landsOnMoPilot(_ event: CGEvent) -> Bool {
        let pid: pid_t?
        if event.type == .keyDown {
            pid = NSWorkspace.shared.frontmostApplication?.processIdentifier
        } else {
            pid = windowOwner(at: event.location)?.pid
        }
        guard let pid else { return false }
        return policy.isMoPilot(Target(pid: pid, bundleId: bundleId(of: pid)))
    }

    // MARK: - Dispatch

    private func dispatch(_ method: String, _ params: [String: Any], _ token: TurnToken?, _ reply: @escaping (Result<Any, HelperError>) -> Void) {
        // a request of a turn that ended or was stopped does nothing, unless it gives the Mac back
        guard turns.admits(method, token) else { return reply(.failure(.staleTurn)) }
        switch method {
        case "hello":
            reply(.success([
                "pid": Int(getpid()),
                "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev",
                "bundleId": Bundle.main.bundleIdentifier ?? "", "sourceDigest": Bundle.main.object(forInfoDictionaryKey: "MPCSourceDigest") as? String ?? "",
                "permissions": permissionStatus(),
                "eventKit": eventKitProtocol,
            ]))
        case "ping":
            reply(.success([:]))
        case "deny.set":
            // Main's extra deny list, replaced as a whole; the built-in rules stay whatever it says.
            guard let ids = params["bundleIds"] as? [String] else { return reply(.failure(.invalidParams("bundleIds"))) }
            policyLock.lock()
            _policy.denyList = DenyList(extra: ids)
            let count = _policy.denyList.rules.count
            policyLock.unlock()
            reply(.success(["rules": count]))
        case "permissions.status":
            reply(.success(permissionStatus()))
        case "permissions.request":
            guard let p = permission(params) else { return reply(.failure(.invalidParams("kind"))) }
            DispatchQueue.main.async {
                requestPermission(p)
                reply(.success(permissionStatus()))
            }
        case "permissions.openSettings":
            guard let p = permission(params) else { return reply(.failure(.invalidParams("kind"))) }
            DispatchQueue.main.async { reply(.success(["opened": openSettings(p)])) }
        case "speech.status", "speech.request", "speech.transcribe", "speech.stream.start", "speech.stream.append", "speech.stream.finish", "speech.stream.cancel":
            dispatchSpeech(method, params, reply) { [weak self] method, params in self?.server.notify(method, params) }
        case _ where eventKitMethods.contains(method):
            dispatchEventKit(method, params, reply)
        case "glow.start":
            // The glow around `pid`'s window while an action runs; repeated starts renew it, `glow.stop` ends it.
            guard let pid = int(params["pid"]), pid > 0 else { return reply(.failure(.invalidParams("pid"))) }
            DispatchQueue.main.async { [glow] in
                glow.start(pid: pid_t(pid))
                reply(.success(["ok": true]))
            }
        case "glow.stop":
            DispatchQueue.main.async { [glow] in
                glow.stop()
                reply(.success(["ok": true]))
            }
        case "input.idle":
            // Seconds since the last physical keyboard or mouse event (the helper's own events don't count).
            let any = CGEventType(rawValue: ~0)!
            reply(.success(["seconds": guardTap.userIdle(hidIdle: CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: any))]))
        case "input.escape":
            // Who sent the latest Escape: "person", "agent" (this helper's post, or another process's synthetic
            // key) or "unknown". MoPilot's Esc-to-stop stops a turn for anything but "agent".
            reply(.success(["sender": guardTap.escapeSender().rawValue]))
        case "record.start": // watch-and-record (WatchRecord.swift): a person's clicks and keys, as record.event notifications
            guard AXIsProcessTrusted(), guardTap.installed else { return reply(.failure(.permission(.accessibility))) }
            reply(.success(["started": recorder.start(includeSynthetic: params["includeSynthetic"] as? Bool == true)]))
        case "record.stop":
            reply(.success(["stopped": recorder.stop()]))
        case "activity.sample": // Computer History (#1363): the allowed apps only (Activity.swift)
            activity.sample(params, deny: policy.denyList) { reply(.success($0)) }
        case "apps.list":
            // The running apps a person switches between, and which one is in front.
            DispatchQueue.main.async { reply(.success(["apps": runningApps()])) }
        case "displays.list":
            DispatchQueue.main.async { reply(.success(["displays": displayList()])) }
        case "input.cursor":
            let p = cursorLocation()
            reply(.success(["x": p.x, "y": p.y]))
        case "control.state":
            reply(.success(controlState()))
        case "control.acquire":
            reply(acquire(holder: params["holder"] as? String ?? "MoPilot", token: token))
        case "turn.revoke":
            // the chat's turns up to `turn` ended or were stopped: their requests are refused from now, and a desktop
            // lock one of them took is let go; with `thread`, only that Codex thread's turns
            guard let chat = params["chat"] as? String, !chat.isEmpty, let turn = TurnToken.number(params["turn"])
            else { return reply(.failure(.invalidParams("chat, turn"))) }
            let held = turns.revoke(chat: chat, thread: params["thread"] as? String, through: turn)
            if held { release() }
            reply(.success(["released": held]))
        case "control.release":
            release()
            reply(.success(controlState()))
        case "control.resume":
            state.lock()
            let ok = controlling
            if ok { paused = nil }
            state.unlock()
            reply(ok ? .success(controlState()) : .failure(.notControlling))
        case "shutdown":
            reply(.success([:]))
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in self?.quit("shutdown") }
        case "apps.hideOthers":
            // Hide-before-action: every visible regular app but the granted ones and MoPilot (main hides its own windows).
            let keep = params["keepBundleIds"] as? [String] ?? []
            let protected = policy.protectedPids
            DispatchQueue.main.async { reply(.success(["hidden": hideApps(keep: keep, protectedPids: protected)])) }
        case "apps.restore":
            // Shows the apps hideOthers hid, then brings back the app that was in front (never MoPilot: main does that).
            let pids = (params["pids"] as? [Any] ?? []).compactMap { int($0) }.map { pid_t($0) }
            let front = int(params["activatePid"]).map { pid_t($0) }
            let protected = policy.protectedPids
            DispatchQueue.main.async { reply(.success(["ok": restoreApps(pids: pids, activate: front.flatMap { protected.contains($0) ? nil : $0 })])) }
        case "pasteboard.save":
            // The user's whole clipboard (every item, every type), kept here until pasteboard.restore.
            DispatchQueue.main.async { [weak self] in
                let saved = savePasteboard()
                self?.savedPasteboard = saved
                reply(.success(["saved": true, "items": saved.count]))
            }
        case "pasteboard.restore":
            // apply: write the saved clipboard back; otherwise (the user copied something since) only forget it.
            let apply = params["apply"] as? Bool ?? true
            DispatchQueue.main.async { [weak self] in
                let saved = self?.savedPasteboard
                self?.savedPasteboard = nil
                if apply, let saved { restorePasteboard(saved) }
                reply(.success(["restored": apply && saved != nil]))
            }
        case "screenshot", "ax.snapshot", "ocr.elements", "target.info", "input.click", "input.type", "input.key", "input.scroll",
             "apps.resolve", "apps.open", "ax.press", "ax.focus", "input.move", "input.drag", "input.button", "input.release",
             "text.focused", "text.insert", "input.paste":
            work.async { [weak self] in
                guard let self else { return }
                // checked again when its place on the queue comes: the turn may have been revoked meanwhile
                guard self.turns.admits(method, token) else { return reply(.failure(.staleTurn)) }
                do { reply(.success(try self.run(method, params))) } catch let e as HelperError { reply(.failure(e)) } catch {
                    reply(.failure(HelperError(-32603, "internal", error.localizedDescription)))
                }
            }
        case "app.cancel": // not on the work queue: that is where the batch (or script run) it stops is running
            if let id = params["batchId"] as? String { cancelAppRun(id) }
            reply(.success(["cancelled": true]))
        case "screen.settle":
            work.async { reply(.success(settleScreen(params))) }
        default:
            // scripts and Shortcuts on their own queue (Script.swift); app-scoped (background) control: AppScoped.swift
            if scriptMethods.contains(method) { return dispatchScript(method, params, reply) }
            guard method.hasPrefix("app.") else { return reply(.failure(.methodNotFound(method))) }
            work.async { [weak self] in
                guard let self else { return }
                guard self.turns.admits(method, token) else { return reply(.failure(.staleTurn)) }
                do { reply(.success(try self.runAppScoped(method, params))) } catch let e as HelperError { reply(.failure(e)) } catch {
                    reply(.failure(HelperError(-32603, "internal", error.localizedDescription)))
                }
            }
        }
    }

    private func permission(_ params: [String: Any]) -> Permission? {
        (params["kind"] as? String).flatMap(Permission.init(rawValue:))
    }

    private func controlState() -> [String: Any] {
        state.lock(); defer { state.unlock() }
        return ["controlling": controlling, "paused": paused?.rawValue ?? NSNull(), "tapInstalled": guardTap.installed]
    }

    private func acquire(holder: String, token: TurnToken?) -> Result<Any, HelperError> {
        if let busy = lock.tryAcquire(holder: holder) { return .failure(.lockBusy(busy)) }
        // granted to the request's turn: revoking that turn lets go of it
        turns.granted(token)
        state.lock()
        controlling = true
        paused = nil
        state.unlock()
        return .success(controlState())
    }

    private func release() {
        state.lock()
        controlling = false
        paused = nil
        state.unlock()
        turns.released()
        lock.release()
    }

    // MARK: - Work queue methods

    private func run(_ method: String, _ params: [String: Any]) throws -> Any {
        switch method {
        case "screenshot":
            guard CGPreflightScreenCaptureAccess() else { throw HelperError.permission(.screenRecording) }
            // up to 2576 px for high-resolution models; main sizes it for the chat's model
            let maxSide = cappedSide(int(params["maxSide"]), fallback: 2000)
            let jpeg = (params["format"] as? String) == "jpeg"
            let quality = double(params["quality"]) ?? 0.8
            // With includeBundleIds: those apps' windows only, on one display (or a region of it); every other
            // window, MoPilot and the deny list never reach the image.
            if let ids = params["includeBundleIds"] as? [String] {
                let display = int(params["display"]).map { CGDirectDisplayID($0) }
                var region: CGRect?
                if let r = params["region"] as? [String: Any], let x = double(r["x"]), let y = double(r["y"]), let w = double(r["width"]), let h = double(r["height"]) {
                    region = CGRect(x: x, y: y, width: w, height: h)
                }
                let protected = policy.protectedPids
                let deny = policy.denyList
                let maxPixels = int(params["maxPixels"])
                // each attempt fetches fresh shareable content: a window or sheet that just opened or closed,
                // or an app still coming forward, gets a moment before the capture is reported as failed
                let shot = try blocking {
                    try await retryingCapture {
                        try await captureApps(bundleIds: ids, displayId: display, region: region, maxSide: maxSide, maxPixels: maxPixels,
                                              excludePids: protected, hide: { deny.rule(for: $0) != nil })
                    }
                }
                let data = try encodeImage(shot.image, jpeg: jpeg, quality: quality)
                var out = screenshotJSON(png: data, width: shot.image.width, height: shot.image.height, display: shot.display, frame: shot.frame)
                if jpeg { out["jpeg"] = out.removeValue(forKey: "png") }
                out["mimeType"] = jpeg ? "image/jpeg" : "image/png"
                out["included"] = shot.included
                out["shown"] = shot.shown
                return out
            }
            // With a pid: that app's windows only (nothing else on screen is captured at all).
            if params["pid"] != nil {
                let (pid, _) = try resolveApp(params)
                let shot = try blocking { try await retryingCapture { try await captureApp(pid: pid, maxSide: maxSide) } }
                guard let png = NSBitmapImageRep(cgImage: shot.image).representation(using: .png, properties: [:]) else {
                    throw HelperError(-32603, "internal", "PNG encoding failed")
                }
                return screenshotJSON(png: png, width: shot.image.width, height: shot.image.height, display: shot.display, frame: shot.frame)
            }
            // Without one (a protected app is in front): the display, minus MoPilot and the deny list.
            let display = int(params["display"]).map { CGDirectDisplayID($0) }
            let protected = policy.protectedPids
            let deny = policy.denyList
            let shot = try blocking {
                try await retryingCapture {
                    try await captureDisplay(display, maxSide: maxSide, excludePids: protected, jpeg: jpeg, quality: quality, hide: { deny.isHiddenFromCapture($0) })
                }
            }
            return screenshotJSON(png: shot.png, width: shot.width, height: shot.height, display: shot.display, frame: shot.frame, jpeg: jpeg)

        case "ax.snapshot":
            guard AXIsProcessTrusted() else { throw HelperError.permission(.accessibility) }
            let (pid, app) = try resolveApp(params)
            var tree = axSnapshot(pid: pid, maxDepth: min(int(params["maxDepth"]) ?? 25, 60), maxNodes: min(int(params["maxNodes"]) ?? 1500, 5000))
            tree["app"] = ["pid": Int(pid), "bundleId": app?.bundleIdentifier ?? "", "name": app?.localizedName ?? ""]
            return tree

        case "ocr.elements":
            // The AX tree flattened plus Vision OCR of the app's own pixels: what a model with no vision can act on.
            guard CGPreflightScreenCaptureAccess() else { throw HelperError.permission(.screenRecording) }
            guard AXIsProcessTrusted() else { throw HelperError.permission(.accessibility) }
            let (pid, app) = try resolveApp(params)
            let maxSide = min(int(params["maxSide"]) ?? 2000, 2000)
            let tree = axSnapshot(pid: pid, maxDepth: 25, maxNodes: 1500)
            let ax = flattenAX(tree["root"] as? [String: Any] ?? [:])
            let shot = try blocking { try await retryingCapture { try await captureApp(pid: pid, maxSide: maxSide) } }
            let lines = try recognizeText(in: shot)
            let merged = mergeElements(ax: ax, ocr: lines, limit: min(int(params["maxElements"]) ?? 400, 1000))
            return [
                "app": ["pid": Int(pid), "bundleId": app?.bundleIdentifier ?? "", "name": app?.localizedName ?? ""],
                "elements": merged.elements.map(\.json),
                "truncated": merged.truncated || (tree["truncated"] as? Bool ?? false),
                "display": ["id": Int(shot.display), "x": shot.frame.minX, "y": shot.frame.minY, "width": shot.frame.width, "height": shot.frame.height],
            ]

        case "target.info":
            // Who a click at (x, y) would reach, or (without a point) who keystrokes would reach.
            let found: [Target]
            if let x = double(params["x"]), let y = double(params["y"]) {
                found = targets(at: CGPoint(x: x, y: y))
            } else {
                found = keyboardTargets()
            }
            guard let t = found.first, let pid = t.pid else { throw HelperError.refused("target unknown") }
            let verdict = policy.check(found)
            var out: [String: Any] = ["pid": Int(pid), "bundleId": t.bundleId ?? "", "name": t.name ?? t.bundleId ?? ""]
            if case .refused(let why) = verdict { out["refused"] = why }
            return out

        case "apps.resolve":
            // Bundle ids or names to installed apps: [{query, app: {bundleId, name, displayName, path, running, pid?} | null, refused?}]
            guard let queries = params["queries"] as? [String] else { throw HelperError.invalidParams("queries") }
            let p = policy
            return ["apps": queries.prefix(50).map { q -> [String: Any] in
                guard let app = findApp(q) else { return ["query": q, "app": NSNull()] }
                var out: [String: Any] = ["query": q, "app": app]
                if let rule = p.denyList.rule(for: app["bundleId"] as? String) { out["refused"] = rule.reason }
                if let pid = app["pid"] as? Int, p.protectedPids.contains(pid_t(pid)) { out["refused"] = "MoPilot" }
                return out
            }]

        case "apps.open":
            guard let id = params["bundleId"] as? String, !id.isEmpty else { throw HelperError.invalidParams("bundleId") }
            if let rule = policy.denyList.rule(for: id) { throw HelperError.refused(rule.reason) }
            if case .refused(let why) = restrict([Target(pid: nil, bundleId: id)], to: params["bundleIds"] as? [String]) { throw HelperError.refused(why) }
            return try openApp(bundleId: id)

        case "text.focused":
            // The keyboard-focused text element of an allowed app, read for main to check typed text against.
            guard AXIsProcessTrusted() else { throw HelperError.permission(.accessibility) }
            guard let f = focusedElement() else { throw HelperError.refused("target unknown") }
            let t = Target(pid: f.pid, bundleId: bundleId(of: f.pid), name: NSRunningApplication(processIdentifier: f.pid)?.localizedName)
            if case .refused(let why) = policy.check([t]) { throw HelperError.refused(why) }
            if case .refused(let why) = restrict([t], to: params["bundleIds"] as? [String]) { throw HelperError.refused(why) }
            if isSecure(f.element) { throw HelperError.refused("a password field") }
            return focusedText(f.element, pid: f.pid, bundleId: t.bundleId)

        case "input.release":
            // Lets go of keys and buttons a timed-out call may have left down; always safe, so no control check.
            for spec in params["keys"] as? [String] ?? [] {
                if let combo = parseKeyCombo(spec) { postKeyEdge(combo, down: false) }
            }
            for b in params["buttons"] as? [String] ?? [] {
                if let button = MouseButton(rawValue: b) { postButton(button, down: false, at: cursorLocation()) }
            }
            return ["ok": true]

        default:
            return try runInput(method, params)
        }
    }

    /// The app a read is about: `pid`, else the frontmost one; refused by the deny list and the per-call grant.
    private func resolveApp(_ params: [String: Any]) throws -> (pid_t, NSRunningApplication?) {
        let pid: pid_t
        if let p = int(params["pid"]) {
            pid = pid_t(p)
        } else if let front = DispatchQueue.main.sync(execute: { NSWorkspace.shared.frontmostApplication?.processIdentifier }) {
            pid = front
        } else {
            throw HelperError.refused("unknown")
        }
        let app = NSRunningApplication(processIdentifier: pid)
        let t = Target(pid: pid, bundleId: app?.bundleIdentifier, name: app?.localizedName)
        if case .refused(let why) = policy.check([t]) { throw HelperError.refused(why) }
        if case .refused(let why) = restrict([t], to: params["bundleIds"] as? [String]) { throw HelperError.refused(why) }
        return (pid, app)
    }

    private func runInput(_ method: String, _ params: [String: Any]) throws -> Any {
        guard AXIsProcessTrusted() else { throw HelperError.permission(.accessibility) }
        // No input without the Esc / take-over watcher.
        guard DispatchQueue.main.sync(execute: { guardTap.install() }) else {
            throw HelperError(8, "guard_unavailable", "cannot watch for Esc and take-over; input is disabled")
        }
        try requireActive()
        switch method {
        case "input.click", "input.scroll":
            guard let x = double(params["x"]), let y = double(params["y"]) else { throw HelperError.invalidParams("x and y are required") }
            let p = CGPoint(x: x, y: y)
            let at = targets(at: p)
            if case .refused(let why) = policy.check(at) { throw HelperError.refused(why) }
            if case .refused(let why) = restrict(at, to: params["bundleIds"] as? [String]) { throw HelperError.refused(why) }
            let owner = at.last
            if method == "input.click" {
                let button = (params["button"] as? String).flatMap(MouseButton.init(rawValue:)) ?? .left
                guard let flags = parseModifiers(params["modifiers"] as? String ?? "") else { throw HelperError.invalidParams("unknown modifier") }
                return try click(at: p, button: button, count: int(params["count"]) ?? 1, flags: flags, owner: owner)
            } else if (params["units"] as? String) == "line" {
                postScrollLines(at: p, dx: Int32(clamping: int(params["dx"]) ?? 0), dy: Int32(clamping: int(params["dy"]) ?? 0))
            } else {
                postScroll(at: p, dx: Int32(clamping: int(params["dx"]) ?? 0), dy: Int32(clamping: int(params["dy"]) ?? 0))
            }
            return ["ok": true, "route": "global", "target": ["bundleId": owner?.bundleId ?? "", "name": owner?.name ?? ""]]

        case "input.move":
            guard let x = double(params["x"]), let y = double(params["y"]) else { throw HelperError.invalidParams("x and y are required") }
            let p = CGPoint(x: x, y: y)
            let at = targets(at: p)
            if case .refused(let why) = policy.check(at) { throw HelperError.refused(why) }
            if case .refused(let why) = restrict(at, to: params["bundleIds"] as? [String]) { throw HelperError.refused(why) }
            postMove(to: p)
            return ["ok": true, "route": "global"]

        case "input.drag":
            // A left-button drag from (x1, y1) to (x2, y2); both ends must land in allowed apps. The button
            // always comes up, whatever happens on the way.
            guard let x1 = double(params["x1"]), let y1 = double(params["y1"]), let x2 = double(params["x2"]), let y2 = double(params["y2"]) else {
                throw HelperError.invalidParams("x1, y1, x2 and y2 are required")
            }
            let a = CGPoint(x: x1, y: y1), b = CGPoint(x: x2, y: y2)
            for p in [a, b] {
                let at = targets(at: p)
                if case .refused(let why) = policy.check(at) { throw HelperError.refused(why) }
                if case .refused(let why) = restrict(at, to: params["bundleIds"] as? [String]) { throw HelperError.refused(why) }
            }
            postMove(to: a)
            postButton(.left, down: true, at: a)
            var last = a
            defer { postButton(.left, down: false, at: last) }
            let steps = 12
            for i in 1...steps {
                if !isActive { throw HelperError(HelperError.aborted.code, "aborted", "aborted by the user during the drag") }
                let t = Double(i) / Double(steps)
                last = CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
                postDragged(to: last)
                usleep(12000)
            }
            return ["ok": true, "route": "global"]

        case "input.button":
            // Presses or lets go of a mouse button at (x, y) (default: where the pointer is).
            let button = (params["button"] as? String).flatMap(MouseButton.init(rawValue:)) ?? .left
            let p = double(params["x"]).flatMap { x in double(params["y"]).map { CGPoint(x: x, y: $0) } } ?? cursorLocation()
            let down = params["down"] as? Bool ?? true
            if down {
                let at = targets(at: p)
                if case .refused(let why) = policy.check(at) { throw HelperError.refused(why) }
                if case .refused(let why) = restrict(at, to: params["bundleIds"] as? [String]) { throw HelperError.refused(why) }
            }
            postButton(button, down: down, at: p)
            return ["ok": true, "route": "global"]

        case "ax.press", "ax.focus":
            // The element an ax.snapshot id names, pressed or focused through accessibility (no pointer, no
            // keystroke). Refused unless the element is still there, inside an allowed app's window.
            guard let pid = int(params["pid"]), let path = params["id"] as? String else { throw HelperError.invalidParams("pid and id are required") }
            let app = NSRunningApplication(processIdentifier: pid_t(pid))
            let t = Target(pid: pid_t(pid), bundleId: app?.bundleIdentifier, name: app?.localizedName)
            if case .refused(let why) = policy.check([t]) { throw HelperError.refused(why) }
            if case .refused(let why) = restrict([t], to: params["bundleIds"] as? [String]) { throw HelperError.refused(why) }
            guard let el = axElement(pid: pid_t(pid), path: path), let frame = axFrameOf(el), frame.width > 0, frame.height > 0 else {
                throw HelperError(14, "element_gone", "element \(path) is gone; take a new screenshot")
            }
            // ids are child-index paths: after the UI changed, the same path can name another control
            if let now = elementMismatch(params["expectElement"] as? [String: Any], role: axString(el, kAXRoleAttribute),
                                         title: axString(el, kAXTitleAttribute), description: axString(el, kAXDescriptionAttribute)) {
                throw HelperError.elementChanged(path, now: now)
            }
            let center = CGPoint(x: frame.midX, y: frame.midY)
            let ok = method == "ax.press" ? axPress(el) : axFocus(el)
            return ["ok": ok, "route": "ax", "center": ["x": center.x, "y": center.y]]

        case "input.key":
            guard let spec = params["key"] as? String, let combo = parseKeyCombo(spec) else { throw HelperError.invalidParams("unknown key") }
            let keys = keyboardTargets()
            if case .refused(let why) = policy.check(keys) { throw HelperError.refused(why) }
            if case .refused(let why) = restrict(keys, to: params["bundleIds"] as? [String]) { throw HelperError.refused(why) }
            if let hold = int(params["holdMs"]), hold > 0 {
                // Held down for up to 100 s; it always comes up, and Esc or a take-over lets go early.
                postKeyEdge(combo, down: true)
                defer { postKeyEdge(combo, down: false) }
                var left = min(hold, maxHoldMs)
                while left > 0 && isActive {
                    usleep(useconds_t(min(left, 50) * 1000))
                    left -= 50
                }
                return ["ok": true, "route": "global"]
            }
            postKey(combo)
            return ["ok": true, "route": "global"]

        case "input.type":
            guard let text = params["text"] as? String else { throw HelperError.invalidParams("text is required") }
            let keys = keyboardTargets()
            if case .refused(let why) = policy.check(keys) { throw HelperError.refused(why) }
            if case .refused(let why) = restrict(keys, to: params["bundleIds"] as? [String]) { throw HelperError.refused(why) }
            if focusIsSecureField() { throw HelperError.refused("a password field") }
            // the frontmost app's own autocorrect, text replacement and smart punctuation off for the call
            let subs = (params["disableSubstitutions"] as? Bool) == true ? keys.first?.bundleId.map { disableSubstitutions(bundleId: $0) } : nil
            defer { subs?() }
            var typed = 0
            for c in text {
                // Esc or a take-over stops typing between characters.
                if !isActive { throw HelperError(HelperError.aborted.code, "aborted", "aborted by the user after \(typed) characters") }
                postCharacter(c)
                typed += 1
                usleep(6000)
            }
            return ["ok": true, "typed": typed]

        case "text.insert":
            // Replaces the focused element's selection through accessibility (no keystrokes, so no autocorrect).
            guard let text = params["text"] as? String else { throw HelperError.invalidParams("text is required") }
            guard let f = focusedElement() else { throw HelperError.refused("target unknown") }
            let t = Target(pid: f.pid, bundleId: bundleId(of: f.pid), name: NSRunningApplication(processIdentifier: f.pid)?.localizedName)
            if case .refused(let why) = policy.check([t]) { throw HelperError.refused(why) }
            if case .refused(let why) = restrict([t], to: params["bundleIds"] as? [String]) { throw HelperError.refused(why) }
            if isSecure(f.element) { throw HelperError.refused("a password field") }
            guard isSettable(f.element, kAXSelectedTextAttribute) else { return ["ok": false, "reason": "not_settable"] }
            let ok = AXUIElementSetAttributeValue(f.element, kAXSelectedTextAttribute as CFString, text as CFString) == .success
            return ok ? ["ok": true, "route": "ax"] : ["ok": false, "reason": "rejected"]

        case "input.paste":
            // cmd+v into the focused element of an allowed app (main put the text on the clipboard first).
            let keys = keyboardTargets()
            if case .refused(let why) = policy.check(keys) { throw HelperError.refused(why) }
            if case .refused(let why) = restrict(keys, to: params["bundleIds"] as? [String]) { throw HelperError.refused(why) }
            if focusIsSecureField() { throw HelperError.refused("a password field") }
            guard let combo = parseKeyCombo("cmd+v") else { throw HelperError.invalidParams("cmd+v") }
            postKey(combo)
            return ["ok": true, "route": "global"]

        default:
            throw HelperError.methodNotFound(method)
        }
    }

    /// input.click: the window's app brought forward first, a plain click on a pressable element in an
    /// out-of-process panel pressed through accessibility, and a row the click didn't select selected
    /// through accessibility (HelperCore/Click.swift). Esc or a take-over while it gets there stops it before
    /// anything lands, as typing and drags stop between steps.
    private func click(at p: CGPoint, button: MouseButton, count: Int, flags: UInt64, owner: Target?) throws -> [String: Any] {
        let plain = isPlainClick(button: button.rawValue, count: count, flags: flags)
        let hit = elementAt(p)
        let ownerPid = owner?.pid
        let regular = ownerPid.flatMap { NSRunningApplication(processIdentifier: $0) }?.activationPolicy == .regular
        let plan = planClick(ClickTarget(frontmostPid: frontmostPid(), ownerPid: ownerPid, ownerIsRegular: regular, hitPid: hit?.pid))
        var out: [String: Any] = ["ok": true, "route": "global", "target": ["bundleId": owner?.bundleId ?? "", "name": owner?.name ?? ""]]
        if let pid = plan.activatePid { out["activated"] = activateForClick(pid) }
        // only a plain click can be finished through accessibility: the others don't read the element
        let info = plain ? hit.map { hitElement($0.element) } : nil
        if !isActive { throw HelperError(HelperError.aborted.code, "aborted", "aborted by the user before the click") }
        if let el = hit?.element, pressInsteadOfClick(plan: plan, plain: plain, hit: info?.hit), axPress(el) {
            out["route"] = "ax"
            out["fallback"] = "press"
            return out
        }
        postClick(at: p, button: button, count: count, flags: flags)
        guard let row = info?.row else { return out }
        usleep(clickSettleMicros)
        // the user took over after the click: their session, nothing more is done in it
        guard isActive else { return out }
        if selectAfterClick(plain: plain, hit: info?.hit, selectedAfter: isSelected(row)),
           AXUIElementSetAttributeValue(row, kAXSelectedAttribute as CFString, kCFBooleanTrue) == .success,
           isSelected(row) == true {
            out["fallback"] = "select"
        }
        return out
    }

    private func requireActive() throws {
        state.lock(); defer { state.unlock() }
        if !controlling { throw HelperError.notControlling }
        if let paused { throw HelperError.paused(paused) }
    }
}

private func screenshotJSON(png: Data, width: Int, height: Int, display: CGDirectDisplayID, frame: CGRect, jpeg: Bool = false) -> [String: Any] {
    [
        jpeg ? "jpeg" : "png": png.base64EncodedString(),
        "width": width,
        "height": height,
        "display": ["id": Int(display), "x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height],
        // Global point = display origin + pixel / pixelsPerPoint.
        "pixelsPerPoint": Double(width) / max(frame.width, 1),
    ].merging(jpeg ? ["mimeType": "image/jpeg"] : [:]) { a, _ in a }
}

private func int(_ v: Any?) -> Int? { (v as? NSNumber)?.intValue }
private func double(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }

/// A result handed from a detached task to the thread waiting on it; the semaphore orders the two accesses.
/// (A captured `var` written from the task is an error in older Swift compilers, e.g. GitHub's macOS runners.)
final class ResultBox<T>: @unchecked Sendable {
    var result: Result<T, Error>?
}

/// Runs async work from the (non-cooperative) work queue and waits for it.
private func blocking<T>(_ body: @escaping () async throws -> T) throws -> T {
    let done = DispatchSemaphore(value: 0)
    let box = ResultBox<T>()
    Task.detached {
        do { box.result = .success(try await body()) } catch { box.result = .failure(error) }
        done.signal()
    }
    done.wait()
    return try box.result!.get()
}
