import AppKit
import HelperCore

/// A soft glow around the window an agent is acting in: the on-screen layer of "MoPilot is controlling
/// this". A transparent, click-through window that follows the target window's frame while an action runs.
/// It belongs to the helper, whose windows never reach a screenshot (display captures exclude the helper's
/// pid and app captures include only the target app), and it opts out of sharing besides. Main thread only.
final class GlowOverlay {
    private var window: NSWindow?
    private var timer: Timer?
    private var hideWork: DispatchWorkItem?
    private var pid: pid_t = 0
    private var deadline = Date.distantPast

    func start(pid: pid_t) {
        hideWork?.cancel()
        hideWork = nil
        self.pid = pid
        deadline = Date().addingTimeInterval(Glow.maxSeconds)
        if window == nil { window = makeWindow() }
        follow()
        if timer == nil {
            let t = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in self?.follow() }
            RunLoop.main.add(t, forMode: .common)
            timer = t
        }
    }

    func stop() {
        guard timer != nil, hideWork == nil else { return }
        let work = DispatchWorkItem { [weak self] in self?.hide() }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Glow.hideDelay, execute: work)
    }

    private func hide() {
        hideWork = nil
        timer?.invalidate()
        timer = nil
        window?.orderOut(nil)
    }

    private func follow() {
        if Date() > deadline { return hide() }
        let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
        let windows = list.compactMap { w -> WindowInfo? in
            guard let pid = w[kCGWindowOwnerPID as String] as? Int32,
                  let b = w[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: b) else { return nil }
            return WindowInfo(pid: pid, layer: w[kCGWindowLayer as String] as? Int ?? 0, alpha: w[kCGWindowAlpha as String] as? Double ?? 1, bounds: rect)
        }
        guard let target = Glow.targetFrame(windows, pid: pid), let screen = NSScreen.screens.first else {
            window?.orderOut(nil)
            return
        }
        window?.setFrame(Glow.overlayFrame(window: target, primaryHeight: screen.frame.height), display: true)
        window?.orderFrontRegardless()
    }

    private func makeWindow() -> NSWindow {
        let w = NSWindow(contentRect: .zero, styleMask: .borderless, backing: .buffered, defer: false)
        w.isOpaque = false
        w.backgroundColor = .clear
        w.hasShadow = false
        w.ignoresMouseEvents = true
        w.level = .floating
        w.sharingType = .none
        w.isReleasedWhenClosed = false
        w.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        w.contentView = GlowView()
        return w
    }
}

private final class GlowView: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func isAccessibilityElement() -> Bool { false }

    override func draw(_ dirtyRect: NSRect) {
        let base = bounds.insetBy(dx: Glow.outset, dy: Glow.outset)
        let color = NSColor(calibratedRed: 0.36, green: 0.56, blue: 1.0, alpha: 1)
        let steps = Int(Glow.outset)
        for i in stride(from: steps, through: 0, by: -1) {
            let t = 1 - CGFloat(i) / CGFloat(steps)
            let r = base.insetBy(dx: -CGFloat(i), dy: -CGFloat(i))
            let path = NSBezierPath(roundedRect: r, xRadius: 10 + CGFloat(i), yRadius: 10 + CGFloat(i))
            path.lineWidth = 1.5
            color.withAlphaComponent(0.06 + 0.5 * t * t).setStroke()
            path.stroke()
        }
    }
}
