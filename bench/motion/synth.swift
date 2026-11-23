// Writes a synthetic screen recording with known motion (a trigger, an eased fade, an eased slide with two dropped frames, a word-by-word reveal, a pause and a layout shift), to check bench/motion-metrics.mjs end to end without recording any screen.
// Usage: synth <out.mov> [cursor|disc]. The timeline is SYNTH_SPEC in bench/lib/motion/cli.mjs and tests/support/motionFrames.ts; keep the three in step.
// With `cursor` it draws a small square (an agent cursor) moving between two points on a spring, twice, on a still page: the timeline of cursorSynthVideo in tests/support/motionFrames.ts. With `disc` the cursor is a grey disc with a light glyph in it (tests/support/motionCursor.ts discVideo).
// The AVAssetReader/Writer calls are the ones macOS 26 (the benchmark VM) has; macOS 27 deprecates them for APIs 26 lacks.
import AVFoundation
import Foundation

let W = 640, H = 400, FPS = 60.0
let discMode = CommandLine.arguments.count > 2 && CommandLine.arguments[2] == "disc"
let cursorMode = discMode || (CommandLine.arguments.count > 2 && CommandLine.arguments[2] == "cursor")
let url = URL(fileURLWithPath: CommandLine.arguments[1])
try? FileManager.default.removeItem(at: url)
let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
  AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: W, AVVideoHeightKey: H,
  AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 20_000_000],
])
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
  kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: W,
  kCVPixelBufferHeightKey as String: H,
])
writer.add(input)
writer.startWriting()
writer.startSession(atSourceTime: .zero)

/// cubic-bezier(x1,y1,x2,y2) at time fraction u, by bisection on x.
func bezier(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, _ u: Double) -> Double {
  func c(_ a: Double, _ b: Double, _ s: Double) -> Double { 3 * a * s * (1 - s) * (1 - s) + 3 * b * s * s * (1 - s) + s * s * s }
  var lo = 0.0, hi = 1.0
  for _ in 0..<40 { let m = (lo + hi) / 2; if c(x1, x2, m) < u { lo = m } else { hi = m } }
  return c(y1, y2, (lo + hi) / 2)
}
func clamp(_ v: Double) -> Double { min(1, max(0, v)) }
/// A unit step through a spring: response is the undamped period in seconds, zeta the damping fraction (below 1).
func spring(_ t: Double, _ response: Double, _ zeta: Double) -> Double {
  if t <= 0 { return 0 }
  let w = 2 * Double.pi / response
  let wd = w * (1 - zeta * zeta).squareRoot()
  return 1 - exp(-zeta * w * t) * (cos(wd * t) + zeta * w / wd * sin(wd * t))
}

let frames = Int((cursorMode ? 3.5 : 4.5) * FPS)
for i in 0..<frames {
  let t = Double(i) / FPS
  // two dropped frames in the middle of the slide
  if !cursorMode && (i == 70 || i == 71) { continue }
  var pb: CVPixelBuffer?
  CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pb)
  let buf = pb!
  CVPixelBufferLockBaseAddress(buf, [])
  let row = CVPixelBufferGetBytesPerRow(buf)
  let base = CVPixelBufferGetBaseAddress(buf)!.assumingMemoryBound(to: UInt8.self)
  func fill(_ x0: Int, _ y0: Int, _ w: Int, _ h: Int, _ v: UInt8) {
    for y in max(0, y0)..<min(H, y0 + h) { for x in max(0, x0)..<min(W, x0 + w) {
      let p = base + y * row + x * 4; p[0] = v; p[1] = v; p[2] = v; p[3] = 255 } }
  }
  if cursorMode {
    // still page; a 12 px square moves (100,120) → (520,280) from 0.5 s and back from 2.0 s, response 0.3 s, damping 0.9
    fill(0, 0, W, H, 235)
    let out = spring(t - 0.5, 0.3, 0.9), back = spring(t - 2.0, 0.3, 0.9)
    let progress = t < 2.0 ? out : 1 - back
    let cx = Int((100 + 420 * progress).rounded()), cy = Int((120 + 160 * progress).rounded())
    if discMode {
      // Sky's cursor: a mid-grey disc 22 px across with a small light pointer glyph in it (disc rows as spans)
      for dy in -11...11 {
        let half = Int((Double(121 - dy * dy)).squareRoot().rounded())
        fill(cx - half, cy + dy, 2 * half, 1, 120)
      }
      fill(cx - 3, cy - 5, 5, 9, 225)
    } else {
      fill(cx - 6, cy - 6, 12, 12, 40)
    }
  } else {
    fill(0, 0, W, H, 32)
    // trigger: a block appears at 0.5 s in the top band (y 0-80)
    if t >= 0.5 { fill(20, 20, 80, 40, 230) }
    // feedback: a fade from 0.6 s to 0.8 s, ease-out cubic-bezier(0,0,.2,1), in the band y 100-180
    let fade = clamp((t - 0.6) / 0.2)
    fill(20, 110, 200, 60, UInt8(32 + 198 * bezier(0, 0, 0.2, 1, fade)))
    // slide: x 40 → 340 from 1.0 s over 0.3 s, cubic-bezier(.32,.72,0,1), in the band y 200-260
    let slide = clamp((t - 1.0) / 0.3)
    fill(40 + Int((300 * bezier(0.32, 0.72, 0, 1, slide)).rounded()), 205, 100, 50, 230)
    // reveal: one word block every 100 ms from 1.5 s to 2.4 s, in the band y 280-320; a pause until 4.0 s
    let words = t < 1.5 ? 0 : min(10, Int((t - 1.5) / 0.1 + 1e-9) + 1)
    for w in 0..<words { fill(20 + w * 50, 285, 40, 30, 200) }
    // layout shift: at 4.0 s the band y 330-400 moves down by 20 px
    fill(20, t >= 4.0 ? 360 : 340, 400, 20, 180)

  }
  CVPixelBufferUnlockBaseAddress(buf, [])
  while !input.isReadyForMoreMediaData { usleep(1000) }
  adaptor.append(buf, withPresentationTime: CMTime(value: CMTimeValue(i), timescale: CMTimeScale(FPS)))
}
input.markAsFinished()
await writer.finishWriting()
if writer.status != .completed { FileHandle.standardError.write("synth failed: \(String(describing: writer.error))\n".data(using: .utf8)!); exit(1) }
