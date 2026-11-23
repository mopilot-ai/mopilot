// Desktop and app screenshot capture, result types and image encoding.
import AppKit
import Foundation
import HelperCore
import ScreenCaptureKit

// MARK: - Screenshot

struct Shot {
    let png: Data
    let width: Int
    let height: Int
    let display: CGDirectDisplayID
    let frame: CGRect
}

/// Captures one display without the windows of `excludePids` and of apps `hide` says to hide. `jpeg` encodes JPEG at `quality` instead of PNG (`Shot.png` then holds the JPEG bytes).
func captureDisplay(_ displayId: CGDirectDisplayID?, maxSide: Int, excludePids: Set<pid_t>, jpeg: Bool = false, quality: Double = 0.8, hide: (String?) -> Bool) async throws -> Shot {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    let wanted = displayId ?? CGMainDisplayID()
    guard let display = content.displays.first(where: { $0.displayID == wanted }) ?? content.displays.first else {
        throw HelperError.invalidParams("no display")
    }
    let excluded = content.applications.filter { excludePids.contains($0.processID) || hide($0.bundleIdentifier) }
    let filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
    let size = captureSize(widthPoints: Double(display.width), heightPoints: Double(display.height),
                           scale: Double(filter.pointPixelScale), maxSide: maxSide)
    let cfg = SCStreamConfiguration()
    cfg.width = size.width
    cfg.height = size.height
    cfg.showsCursor = false
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
    let png = jpeg
        ? try encodeImage(image, jpeg: true, quality: quality)
        : try { guard let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            throw HelperError(-32603, "internal", "PNG encoding failed")
        }; return data }()
    return Shot(png: png, width: image.width, height: image.height, display: display.displayID, frame: CGDisplayBounds(display.displayID))
}

/// One app's windows on the display they are mostly on, as pixels (nothing else on screen is in it).
struct AppShot {
    let image: CGImage
    let display: CGDirectDisplayID
    let frame: CGRect
    var pixelsPerPoint: Double { Double(image.width) / max(frame.width, 1) }
}

/// Captures only `pid`'s windows (other apps, MoPilot and the deny list never reach the image).
func captureApp(pid: pid_t, maxSide: Int) async throws -> AppShot {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let app = content.applications.first(where: { $0.processID == pid }) else { throw NoWindowsToCapture() }
    let windows = content.windows.filter { $0.owningApplication?.processID == pid && $0.isOnScreen && $0.windowLayer == 0 }
    guard let main = windows.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else {
        throw NoWindowsToCapture()
    }
    let center = CGPoint(x: main.frame.midX, y: main.frame.midY)
    guard let display = content.displays.first(where: { CGDisplayBounds($0.displayID).contains(center) }) ?? content.displays.first else {
        throw HelperError.invalidParams("no display")
    }
    let filter = SCContentFilter(display: display, including: [app], exceptingWindows: [])
    let size = captureSize(widthPoints: Double(display.width), heightPoints: Double(display.height),
                           scale: Double(filter.pointPixelScale), maxSide: maxSide)
    let cfg = SCStreamConfiguration()
    cfg.width = size.width
    cfg.height = size.height
    cfg.showsCursor = false
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
    return AppShot(image: image, display: display.displayID, frame: CGDisplayBounds(display.displayID))
}

/// A capture of some apps' windows only: everything else on the display (other apps, MoPilot, the
/// deny list, the desktop) is left out of the image. `region` (global points) crops to part of the display.
struct AppsShot {
    let image: CGImage
    let display: CGDirectDisplayID
    /// What the image covers, in global points.
    let frame: CGRect
    let included: [String]
    /// The included apps with a window in `frame`: what the image actually shows.
    let shown: [String]
}

func captureApps(bundleIds: [String], displayId: CGDirectDisplayID?, region: CGRect?, maxSide: Int, maxPixels: Int?,
                 excludePids: Set<pid_t>, hide: (String?) -> Bool) async throws -> AppsShot {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    let wanted = Set(bundleIds.map { $0.lowercased() })
    let apps = content.applications.filter {
        wanted.contains($0.bundleIdentifier.lowercased()) && !excludePids.contains($0.processID) && !hide($0.bundleIdentifier)
    }
    // a filter that includes no app fails to capture at all ("Failed to start stream due to audio/video
    // capture failure"); say what is actually wrong so the caller can wait for a window and retry
    guard !apps.isEmpty else { throw NoWindowsToCapture() }
    let displays = content.displays.map { (id: $0.displayID, bounds: CGDisplayBounds($0.displayID)) }
    var pick = displayId
    if pick == nil, let region {
        pick = displays.first { $0.bounds.contains(CGPoint(x: region.midX, y: region.midY)) }?.id
    }
    if pick == nil {
        let pids = Set(apps.map(\.processID))
        let front = frontmostPid()
        let preferred = front.map { pids.contains($0) ? [$0] : [] } ?? []
        pick = chooseDisplay(windows: onScreenWindows(), preferredPids: preferred, includedPids: pids, displays: displays)
    }
    let target = pick ?? CGMainDisplayID()
    guard let display = content.displays.first(where: { $0.displayID == target }) ?? content.displays.first else {
        throw HelperError.invalidParams("no display")
    }
    let bounds = CGDisplayBounds(display.displayID)
    let filter = SCContentFilter(display: display, including: apps, exceptingWindows: [])
    let cfg = SCStreamConfiguration()
    var frame = bounds
    if let region {
        let r = region.intersection(bounds)
        guard !r.isNull, r.width >= 1, r.height >= 1 else { throw HelperError.invalidParams("region is off the display") }
        frame = r
        cfg.sourceRect = CGRect(x: r.minX - bounds.minX, y: r.minY - bounds.minY, width: r.width, height: r.height)
    }
    let size = captureSize(widthPoints: Double(frame.width), heightPoints: Double(frame.height),
                           scale: Double(filter.pointPixelScale), maxSide: maxSide, maxPixels: maxPixels)
    cfg.width = size.width
    cfg.height = size.height
    cfg.showsCursor = false
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
    let shownPids = pidsShown(windows: onScreenWindows(), includedPids: Set(apps.map(\.processID)), frame: frame)
    return AppsShot(image: image, display: display.displayID, frame: frame, included: apps.map(\.bundleIdentifier),
                    shown: apps.filter { shownPids.contains($0.processID) }.map(\.bundleIdentifier))
}

/// PNG, or JPEG at `quality` (0...1).
func encodeImage(_ image: CGImage, jpeg: Bool, quality: Double) throws -> Data {
    let rep = NSBitmapImageRep(cgImage: image)
    let data = jpeg
        ? rep.representation(using: .jpeg, properties: [.compressionFactor: max(0.1, min(quality, 1))])
        : rep.representation(using: .png, properties: [:])
    guard let data else { throw HelperError(-32603, "internal", "image encoding failed") }
    return data
}
