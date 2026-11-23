// Decodes a screen recording (.mov) or a folder of screencast frames (CDP Page.startScreencast images listed in frames.json) into grayscale frames with exact times, for bench/lib/motion: reads files only, never the screen.
// Usage: decode <in.mov | frames folder> <out.frames> [scale [WxH crop from the top-left]]. Output: one JSON header line {"width","height","scale","source"},
// then per frame a little-endian float64 time in seconds and width*height bytes of luma (block-averaged by `scale`).
// The AVAssetReader calls are the ones macOS 26 (the benchmark VM) has; macOS 27 deprecates them for APIs 26 lacks.
import AVFoundation
import CoreGraphics
import Foundation
import ImageIO

func fail(_ message: String) -> Never {
  FileHandle.standardError.write("\(message)\n".data(using: .utf8)!)
  exit(1)
}

let args = CommandLine.arguments
guard args.count >= 3 else {
  FileHandle.standardError.write("usage: decode <in.mov | frames folder> <out.frames> [scale]\n".data(using: .utf8)!)
  exit(2)
}
let scale = max(1, Int(args.count > 3 ? args[3] : "4") ?? 4)
// optional 5th argument "WxH": keep only that many pixels from the top-left corner of every frame
let cropParts = args.count > 4 ? args[4].split(separator: "x").compactMap { Int($0) } : []
let cropW = cropParts.count == 2 ? max(1, cropParts[0]) : Int.max
let cropH = cropParts.count == 2 ? max(1, cropParts[1]) : Int.max
FileManager.default.createFile(atPath: args[2], contents: nil)
let out = FileHandle(forWritingAtPath: args[2])!
var header: (w: Int, h: Int)? = nil
var count = 0

/// Writes one BGRA image as a frame: the header first (from the first frame's size), then its time and its luma.
func emit(_ base: UnsafePointer<UInt8>, _ fullW: Int, _ fullH: Int, _ row: Int, _ t: Double) {
  // an optional crop from the top-left corner keeps long, high-rate recordings small enough to read whole
  let w = min(fullW, cropW), h = min(fullH, cropH)
  if header == nil {
    header = (w, h)
    out.write("{\"width\":\(w / scale),\"height\":\(h / scale),\"scale\":\(scale),\"source\":[\(w),\(h)]}\n".data(using: .utf8)!)
  }
  // every frame has the first one's size: a frame of another size is cut or padded with black
  let (fw, fh) = header!
  let ow = fw / scale, oh = fh / scale
  var frame = Data(count: 8 + ow * oh)
  frame.withUnsafeMutableBytes { (buf: UnsafeMutableRawBufferPointer) in
    buf.storeBytes(of: t.bitPattern.littleEndian, toByteOffset: 0, as: UInt64.self)
    let px = buf.baseAddress!.advanced(by: 8).assumingMemoryBound(to: UInt8.self)
    let n = scale * scale
    for y in 0..<oh {
      for x in 0..<ow {
        var sum = 0
        for dy in 0..<scale {
          let sy = y * scale + dy
          if sy >= h { continue }
          let p = base + sy * row
          for dx in 0..<scale {
            let sx = x * scale + dx
            if sx >= w { continue }
            let q = p + sx * 4
            // Rec. 601 luma from BGRA
            sum += (29 * Int(q[0]) + 150 * Int(q[1]) + 77 * Int(q[2])) >> 8
          }
        }
        px[y * ow + x] = UInt8(sum / n)
      }
    }
  }
  out.write(frame)
  count += 1
}

var isDir: ObjCBool = false
if FileManager.default.fileExists(atPath: args[1], isDirectory: &isDir), isDir.boolValue {
  // a screencast: frames.json lists [{file, t}] with t in seconds from the first frame
  let dir = URL(fileURLWithPath: args[1])
  guard let data = try? Data(contentsOf: dir.appendingPathComponent("frames.json")),
    let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
  else { fail("no frames.json in \(args[1])") }
  for item in list {
    guard let file = item["file"] as? String, let t = (item["t"] as? NSNumber)?.doubleValue else { fail("bad frames.json entry: \(item)") }
    guard let src = CGImageSourceCreateWithURL(dir.appendingPathComponent(file) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(src, 0, nil)
    else { fail("cannot read \(file)") }
    let w = image.width, h = image.height, row = w * 4
    var pixels = [UInt8](repeating: 0, count: row * h)
    let info = CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    pixels.withUnsafeMutableBytes { raw in
      let ctx = CGContext(data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: row,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: info)!
      ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    }
    pixels.withUnsafeBufferPointer { emit($0.baseAddress!, w, h, row, t) }
  }
} else {
  let asset = AVURLAsset(url: URL(fileURLWithPath: args[1]))
  guard let track = try await asset.loadTracks(withMediaType: .video).first else { fail("no video track in \(args[1])") }
  let reader = try AVAssetReader(asset: asset)
  let output = AVAssetReaderTrackOutput(
    track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
  reader.add(output)
  guard reader.startReading() else { fail("cannot read \(args[1]): \(String(describing: reader.error))") }
  while let sample = output.copyNextSampleBuffer() {
    guard let image = CMSampleBufferGetImageBuffer(sample) else { continue }
    let t = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample))
    CVPixelBufferLockBaseAddress(image, .readOnly)
    let base = CVPixelBufferGetBaseAddress(image)!.assumingMemoryBound(to: UInt8.self)
    emit(base, CVPixelBufferGetWidth(image), CVPixelBufferGetHeight(image), CVPixelBufferGetBytesPerRow(image), t)
    CVPixelBufferUnlockBaseAddress(image, .readOnly)
  }
  if reader.status == .failed { fail("decode failed after \(count) frames: \(String(describing: reader.error))") }
}
out.closeFile()
FileHandle.standardError.write("\(count) frames\n".data(using: .utf8)!)
