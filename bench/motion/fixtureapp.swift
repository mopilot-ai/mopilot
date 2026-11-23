// The motion bench's computer-use fixture as a native, non-browser app: one 1280x800 window holding a WKWebView on the fixture page, so every arm's computer use may click it (MoPilot's treats browsers as view-only). Usage: fixtureapp <url> [pid-file]. Quits on window close or SIGTERM.
import AppKit
import WebKit

let args = CommandLine.arguments
guard args.count >= 2, let url = URL(string: args[1]) else {
  FileHandle.standardError.write(Data("usage: fixtureapp <url> [pid-file]\n".utf8))
  exit(2)
}
if args.count >= 3 {
  try? "\(getpid())\n".write(toFile: args[2], atomically: true, encoding: .utf8)
}

/// A click that reaches the window while another app is active is the click, not only the window's activation (a background agent's events arrive that way).
final class ClickableWebView: WKWebView {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// The native-drawn variant (`?native=<points json>` on the URL): the same dots, HUD and event log as the page, but drawn by this view, so the click path under test is a plain AppKit view's, not WebKit's.
final class DotsView: NSView {
  var dots: [CGPoint] = []
  let endpoint: URL
  let planURL: URL
  var seq = 0
  var at = 0
  init(frame: NSRect, endpoint: URL, planURL: URL) {
    self.endpoint = endpoint
    self.planURL = planURL
    super.init(frame: frame)
  }
  required init?(coder: NSCoder) { fatalError() }
  override var isFlipped: Bool { true }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  func post(_ type: String, _ data: [String: Any] = [:]) {
    var e = data
    e["type"] = type
    e["t"] = Int((Date().timeIntervalSince1970 * 1000).rounded())
    var req = URLRequest(url: endpoint)
    req.httpMethod = "POST"
    req.httpBody = try? JSONSerialization.data(withJSONObject: e)
    URLSession.shared.dataTask(with: req).resume()
  }

  /// The run's plans arrive one after the other from the fixture server (`GET /plan`: {seq, points}); a new seq restarts the dots in this same window, so one window serves the whole run.
  func poll(announce: @escaping (Int) -> Void) {
    Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
      guard let self else { return }
      URLSession.shared.dataTask(with: self.planURL) { data, _, _ in
        guard let data, let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let n = (o["seq"] as? NSNumber)?.intValue,
              n != self.seq, n > 0, let raw = o["points"] as? [[String: Any]] else { return }
        let dots = raw.compactMap { d -> CGPoint? in
          guard let x = (d["x"] as? NSNumber)?.doubleValue, let y = (d["y"] as? NSNumber)?.doubleValue else { return nil }
          return CGPoint(x: x, y: y)
        }
        DispatchQueue.main.async {
          self.seq = n
          self.dots = dots
          self.at = 0
          announce(n)
        }
      }.resume()
    }
  }

  func showNext() {
    needsDisplay = true
    if at < dots.count { post("show", ["i": at, "x": dots[at].x, "y": dots[at].y]) } else { post("done") }
  }

  override func draw(_ rect: NSRect) {
    NSColor(srgbRed: 0xeb / 255, green: 0xeb / 255, blue: 0xeb / 255, alpha: 1).setFill()
    bounds.fill()
    if at < dots.count {
      NSColor(srgbRed: 0, green: 0xa6 / 255, blue: 0x76 / 255, alpha: 1).setFill()
      NSBezierPath(ovalIn: NSRect(x: dots[at].x - 14, y: dots[at].y - 14, width: 28, height: 28)).fill()
    }
    let text = at < dots.count ? "Dot \(at + 1) of \(dots.count)" : "Done"
    text.draw(at: NSPoint(x: 8, y: 8), withAttributes: [.font: NSFont.systemFont(ofSize: 15), .foregroundColor: NSColor(white: 0.13, alpha: 1)])
  }

  override func mouseDown(with event: NSEvent) {
    let p = convert(event.locationInWindow, from: nil)
    let hit = at < dots.count && hypot(p.x - dots[at].x, p.y - dots[at].y) <= 14
    let screen = window?.convertPoint(toScreen: event.locationInWindow) ?? .zero
    let top = (NSScreen.screens.first ?? NSScreen.main!).frame.maxY
    post("click", ["i": at, "hit": hit, "cx": p.x, "cy": p.y, "sx": screen.x, "sy": top - screen.y, "trusted": true])
    if hit {
      at += 1
      showNext()
    }
  }
}

final class Delegate: NSObject, NSApplicationDelegate {
  let url: URL
  var window: NSWindow!

  init(url: URL) { self.url = url }

  func applicationDidFinishLaunching(_ note: Notification) {
    let native = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "native" }?.value
    let size = NSRect(x: 0, y: 0, width: 1280, height: 800)
    let web = ClickableWebView(frame: size)
    web.autoresizingMask = [.width, .height]
    let win = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800),
      styleMask: [.titled, .closable, .miniaturizable],
      backing: .buffered,
      defer: false)
    win.title = "Motion fixture"
    win.isReleasedWhenClosed = false
    var dotsView: DotsView?
    if native != nil {
      var base = URLComponents(url: url, resolvingAgainstBaseURL: false)!
      base.query = nil
      base.path = "/event"
      let endpoint = base.url!
      base.path = "/plan"
      dotsView = DotsView(frame: size, endpoint: endpoint, planURL: base.url!)
      dotsView!.autoresizingMask = [.width, .height]
      win.contentView = dotsView
    } else {
      win.contentView = web
    }
    win.setContentSize(NSSize(width: 1280, height: 800))
    // top-left of the usable screen, just below the menu bar
    let visible = (NSScreen.main ?? NSScreen.screens[0]).visibleFrame
    win.setFrameTopLeftPoint(NSPoint(x: visible.minX, y: visible.maxY))
    // the page cannot read a WKWebView's place on the screen: tell it where its content view's top-left is, in screen points
    let content = win.contentRect(forFrameRect: win.frame)
    let screenTop = (NSScreen.screens.first ?? NSScreen.main!).frame.maxY
    let script = "window.__motionFrame = {x: \(content.minX), y: \(screenTop - content.maxY), width: \(content.width), height: \(content.height)};"
    web.configuration.userContentController.addUserScript(
      WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    win.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    window = win
    if let dotsView {
      dotsView.poll { n in
        dotsView.post("ready", ["seq": n, "viewport": [content.width, content.height], "dpr": win.backingScaleFactor, "frame": ["x": content.minX, "y": screenTop - content.maxY, "width": content.width, "height": content.height]])
        dotsView.showNext()
      }
    } else {
      web.load(URLRequest(url: url))
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = Delegate(url: url)
app.delegate = delegate
signal(SIGTERM, SIG_IGN)
let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
term.setEventHandler { NSApp.terminate(nil) }
term.resume()
app.run()
