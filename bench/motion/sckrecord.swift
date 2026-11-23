// Records the main display with ScreenCaptureKit at a high frame rate into an H.264 .mov whose frame times are the capture's own presentation times, for bench/lib/motion (the screen recorder path stays as the fallback); never run on a real Mac.
// Usage: sckrecord <out.mov> <max seconds> <fps> [--no-cursor] [--retina]. Captures at the display's point size (1x) unless --retina. Stops at the time limit or when <out.mov>.stop exists.
// Stdout, once, at the first frame: {"startedAtMs": wall-clock epoch ms of that frame, "width", "height", "fps"}. Stderr at the end: a frame count.
// ScreenCaptureKit delivers a frame only when the screen changed, so a still screen leaves gaps, and a virtual display may refresh slower than asked (bench/README.md).
// Needs the Screen Recording grant for this binary (bench/vm-grant.sh).
import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

func fail(_ message: String) -> Never {
  FileHandle.standardError.write("\(message)\n".data(using: .utf8)!)
  exit(1)
}

let args = CommandLine.arguments
guard args.count >= 4, let limit = Double(args[2]), let fps = Int(args[3]), fps > 0 else {
  FileHandle.standardError.write("usage: sckrecord <out.mov> <max seconds> <fps> [--no-cursor] [--retina]\n".data(using: .utf8)!)
  exit(2)
}
let outURL = URL(fileURLWithPath: args[1])
let stopFile = args[1] + ".stop"
let showsCursor = !args.contains("--no-cursor")
let retina = args.contains("--retina")
try? FileManager.default.removeItem(at: outURL)
try? FileManager.default.removeItem(atPath: stopFile)

/// Writes each complete frame to the movie, re-timed to start at zero, and reports the first frame's wall-clock time.
final class Recorder: NSObject, SCStreamOutput {
  let writer: AVAssetWriter
  let input: AVAssetWriterInput
  let width: Int, height: Int
  let fps: Int
  var first: CMTime?
  var frames = 0

  init(url: URL, width: Int, height: Int, fps: Int) throws {
    self.fps = fps
    self.width = width
    self.height = height
    writer = try AVAssetWriter(outputURL: url, fileType: .mov)
    input = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height,
      AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 40_000_000],
    ])
    input.expectsMediaDataInRealTime = true
    writer.add(input)
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, sampleBuffer.isValid, CMSampleBufferGetImageBuffer(sampleBuffer) != nil else { return }
    // frames the capture marks idle or blank carry no new picture
    if let list = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
      let raw = list.first?[.status] as? Int, SCFrameStatus(rawValue: raw) != .complete { return }
    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    if first == nil {
      first = pts
      writer.startWriting()
      writer.startSession(atSourceTime: .zero)
      // the frame's wall-clock time: now, less how long ago the host clock read this presentation time
      let ago = CMTimeGetSeconds(CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), pts))
      let startedAt = Date().timeIntervalSince1970 * 1000 - ago * 1000
      print("{\"startedAtMs\":\(startedAt),\"width\":\(width),\"height\":\(height),\"fps\":\(fps)}")
      fflush(stdout)
    }
    guard input.isReadyForMoreMediaData, writer.status == .writing else { return }
    var timing = CMSampleTimingInfo(duration: CMSampleBufferGetDuration(sampleBuffer), presentationTimeStamp: CMTimeSubtract(pts, first!), decodeTimeStamp: .invalid)
    var retimed: CMSampleBuffer?
    guard CMSampleBufferCreateCopyWithNewTiming(allocator: nil, sampleBuffer: sampleBuffer, sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleBufferOut: &retimed) == noErr,
      let frame = retimed else { return }
    if input.append(frame) { frames += 1 }
  }
}

// connect to the window server before asking for shareable content
_ = CGMainDisplayID()
let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
guard let display = content.displays.first else { fail("no display to record") }
let filter = SCContentFilter(display: display, excludingWindows: [])
// 1x (the display's point size) unless --retina asks for its pixel size
let scale = retina ? Double(filter.pointPixelScale) : 1.0
let config = SCStreamConfiguration()
config.width = Int(Double(display.width) * scale)
config.height = Int(Double(display.height) * scale)
config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
config.pixelFormat = kCVPixelFormatType_32BGRA
config.showsCursor = showsCursor
config.queueDepth = 8
let recorder = try Recorder(url: outURL, width: config.width, height: config.height, fps: fps)
let stream = SCStream(filter: filter, configuration: config, delegate: nil)
try stream.addStreamOutput(recorder, type: .screen, sampleHandlerQueue: DispatchQueue(label: "sckrecord.frames"))
try await stream.startCapture()
let deadline = Date().addingTimeInterval(limit)
while Date() < deadline && !FileManager.default.fileExists(atPath: stopFile) { try await Task.sleep(nanoseconds: 100_000_000) }
try await stream.stopCapture()
if recorder.first == nil { fail("no frame arrived: is Screen Recording granted to this binary?") }
recorder.input.markAsFinished()
await recorder.writer.finishWriting()
if recorder.writer.status != .completed { fail("write failed: \(String(describing: recorder.writer.error))") }
try? FileManager.default.removeItem(atPath: stopFile)
FileHandle.standardError.write("\(recorder.frames) frames\n".data(using: .utf8)!)
