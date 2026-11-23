import CoreGraphics
import Foundation

/// One entry of the window list (CGWindowListCopyWindowInfo), reduced to what the glow follows.
public struct WindowInfo: Equatable {
    public var pid: Int32
    public var layer: Int
    public var alpha: Double
    public var bounds: CGRect

    public init(pid: Int32, layer: Int, alpha: Double, bounds: CGRect) {
        self.pid = pid
        self.layer = layer
        self.alpha = alpha
        self.bounds = bounds
    }
}

/// The glow drawn around the window an agent is acting in: where it goes. Pure, so it is tested without a screen.
public enum Glow {
    /// How far the glow reaches past the window's edge, in points.
    public static let outset: CGFloat = 10
    /// A stop waits this long, so two calls in a row keep one steady glow instead of flickering.
    public static let hideDelay: TimeInterval = 0.4
    /// A start nobody renews or stops (main died, a lost message) ends by itself after this long.
    public static let maxSeconds: TimeInterval = 120
    /// Windows smaller than this (tooltips, helper panels) are not the app's window.
    static let minSide: CGFloat = 40

    /// The topmost ordinary window of `pid`. `windows` is front to back, as the window list returns it.
    public static func targetFrame(_ windows: [WindowInfo], pid: Int32) -> CGRect? {
        windows.first { $0.pid == pid && $0.layer == 0 && $0.alpha > 0 && $0.bounds.width >= minSide && $0.bounds.height >= minSide }?.bounds
    }

    /// The overlay's frame in AppKit coordinates (bottom-left origin) for a window frame in global points
    /// (top-left origin); `primaryHeight` is the height of the primary display.
    public static func overlayFrame(window cg: CGRect, primaryHeight: CGFloat) -> CGRect {
        CGRect(x: cg.minX - outset, y: primaryHeight - cg.maxY - outset, width: cg.width + 2 * outset, height: cg.height + 2 * outset)
    }
}
