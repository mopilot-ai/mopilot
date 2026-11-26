// Makes a picked video smaller so it fits what the computer takes: an export session down a ladder of sizes with a length limit, progress, cancel, and its own temporary files (#5638).
import AVFoundation
import ExpoModulesCore
import UIKit

/// The sizes tried, largest first (Medium is about 480x360; the system's Low size, about 192x144, is left out: nobody can watch it). A size whose
/// estimated output is far above the limit is skipped without being exported, but the smallest is always tried, because an estimate is a guess and
/// is never the whole reason to refuse. A session that reaches the limit stops and keeps what it has, so an output shorter than the source is not
/// an answer either: the next, smaller size is tried, and a video even the smallest cannot hold in full is refused.
private let ladder = [
  AVAssetExportPreset1280x720, AVAssetExportPreset960x540, AVAssetExportPreset640x480, AVAssetExportPresetMediumQuality,
]
/// The estimate of a size is trusted when it says the output will be well above the limit: it is a guess, so only by this factor.
private let estimateMargin = 1.1
/// A finished export may be this many seconds shorter than the source (a frame or two, and the sound's priming) and still be all of it. An output
/// cut short by more than this is never sent, and one cut by less loses at most this much of the end.
private let durationSlack = 0.25
/// Within one launch (the app's code reloaded), what a module before this one left is wanted by no one once it is this old; a younger file may be an export
/// still being written. What an earlier launch left (a kill, a crash) goes whatever its age: a new process has no pick in flight.
private let staleAfter: TimeInterval = 10 * 60
/// This process: the same across reloads of the app's code, new at every launch.
private let launch = UUID().uuidString
/// A video the picker copied and nobody tracked (the app was killed between the picker returning and `track`) is removed at launch once it is this old.
private let staleVideoAfter: TimeInterval = 60 * 60

/// Ends a background task once, whether the export ended it or iOS ran out of time first, and whichever of beginning and ending happens first.
private final class BackgroundTask {
  private let lock = NSLock()
  private var identifier = UIBackgroundTaskIdentifier.invalid
  private var finished = false

  func begin(expiring: @escaping () -> Void) {
    DispatchQueue.main.async {
      let started = UIApplication.shared.beginBackgroundTask(withName: "MoPilotVideo") {
        // the system calls this on the main thread, and expects the task ended before it returns
        expiring()
        self.endNow()
      }
      self.lock.lock()
      let alreadyDone = self.finished
      if !alreadyDone { self.identifier = started }
      self.lock.unlock()
      if alreadyDone, started != .invalid { UIApplication.shared.endBackgroundTask(started) }
    }
  }

  /// Ends it at once; for callers already on the main thread.
  func endNow() {
    guard let ending = finish() else { return }
    UIApplication.shared.endBackgroundTask(ending)
  }

  func end() {
    guard let ending = finish() else { return }
    DispatchQueue.main.async { UIApplication.shared.endBackgroundTask(ending) }
  }

  /// Marks it finished and hands back the identifier to end, once.
  private func finish() -> UIBackgroundTaskIdentifier? {
    lock.lock()
    finished = true
    let ending = identifier
    identifier = .invalid
    lock.unlock()
    return ending == .invalid ? nil : ending
  }
}

public final class MoPilotVideoModule: Module {
  private let lock = NSLock()
  private var sessions: [String: AVAssetExportSession] = [:]
  private var cancelled: Set<String> = []
  private var expired: Set<String> = []
  private let folder = FileManager.default.temporaryDirectory.appendingPathComponent("mopilot-video", isDirectory: true)

  public func definition() -> ModuleDefinition {
    Name("MoPilotVideo")
    Events("onProgress", "onRung")

    // what an earlier launch left (a crash, a kill mid-export) is not wanted by anyone; within this launch a file younger than `staleAfter` may be one a
    // reloaded app is still writing. Off the main thread: a folder of gigabyte copies is slow to list and remove, and the app is starting
    OnCreate {
      DispatchQueue.global(qos: .utility).async {
        self.removeStale(in: self.folder)
        self.sweepTracked()
        self.sweepPickerVideos()
      }
    }

    // The picker's copies of the videos picked (a full-size original each): the phone says which they are, so a copy a killed app left can be removed at the
    // next launch without touching anything else in the picker's cache (a camera photo may still be a thumbnail on screen).
    Function("track") { (uris: [String]) in
      self.track(uris)
    }
    Function("untrack") { (uri: String) in
      self.untrack(uri)
    }

    // `uri` a file of the picker, `id` what `cancel` and the progress events name it by, `limit` the most bytes the result may have
    AsyncFunction("compress") { (uri: String, id: String, limit: Int, promise: Promise) in
      _ = Task {
        let background = BackgroundTask()
        // the export goes on for the seconds iOS gives a backgrounded app; past that it is stopped, and the person is told why
        background.begin {
          self.markExpired(id)
          self.cancel(id)
        }
        do {
          promise.resolve(try await self.run(uri: uri, id: id, limit: limit))
        } catch let error as Exception {
          promise.reject(error)
        } catch {
          promise.reject(Exception(name: "VideoExportFailed", description: error.localizedDescription, code: "ERR_VIDEO_EXPORT"))
        }
        background.end()
        self.forget(id)
      }
    }

    Function("cancel") { (id: String) in
      self.cancel(id)
    }
  }

  private func run(uri: String, id: String, limit: Int) async throws -> [String: Any] {
    guard let url = URL(string: uri), url.isFileURL else {
      throw Exception(name: "VideoNotAFile", description: "The video is not a file on this phone.", code: "ERR_VIDEO_EXPORT")
    }
    let source = AVURLAsset(url: url)
    let seconds = try await source.load(.duration).seconds
    // a duration that is not a number is a file that cannot be exported: not a video that is too long
    guard seconds.isFinite, seconds > 0 else {
      throw Exception(name: "VideoUnreadable", description: "The video's length could not be read.", code: "ERR_VIDEO_EXPORT")
    }
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

    // the sizes worth exporting: those the system can make of this video and whose estimate is not far above the limit. The smallest the system can make is
    // always tried: an estimate comes from a size's usual bit rate, and a quiet picture is often well below it.
    var plan: [(preset: String, session: AVAssetExportSession, estimate: Int64)] = []
    var smallest: (preset: String, session: AVAssetExportSession, estimate: Int64)?
    for preset in ladder {
      try stopIfCancelled(id)
      guard await AVAssetExportSession.compatibility(ofExportPreset: preset, with: source, outputFileType: .mp4) else { continue }
      guard let session = AVAssetExportSession(asset: source, presetName: preset) else { continue }
      let estimate = await estimatedLength(of: session)
      smallest = (preset, session, estimate)
      if estimate > 0 && Double(estimate) > Double(limit) * estimateMargin {
        report(id, preset: preset, estimate: estimate, bytes: 0, seconds: 0, outcome: "skipped")
        continue
      }
      plan.append((preset, session, estimate))
    }
    // (every size was skipped on its estimate: the smallest is then reported as skipped above and again when it is tried here)
    if plan.isEmpty, let last = smallest { plan = [last] }

    for (position, entry) in plan.enumerated() {
      try stopIfCancelled(id)
      let session = entry.session
      let output = folder.appendingPathComponent(PickerPaths.outputName(launch: launch))
      session.outputURL = output
      session.outputFileType = .mp4
      session.fileLengthLimit = Int64(limit)
      session.shouldOptimizeForNetworkUse = true
      if register(session, id: id) { throw stopReason(id) }
      let began = Date()
      // how far the size being made is, and whether it is a smaller one tried after another gave up (the phone says so, instead of a line that goes back)
      let retry = position > 0
      let ticker = Task {
        while !Task.isCancelled {
          self.sendEvent("onProgress", ["id": id, "progress": Double(session.progress), "retry": retry])
          try? await Task.sleep(nanoseconds: 200_000_000)
        }
      }
      await session.export()
      ticker.cancel()
      if session.status == .completed { self.sendEvent("onProgress", ["id": id, "progress": 1.0, "retry": retry]) }
      unregister(id)
      let took = Date().timeIntervalSince(began)
      let written = (try? output.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
      if session.status == .cancelled || isCancelled(id) {
        report(id, preset: entry.preset, estimate: entry.estimate, bytes: written, seconds: took, outcome: "cancelled")
        try? FileManager.default.removeItem(at: output)
        throw stopReason(id)
      }
      if session.status != .completed {
        report(id, preset: entry.preset, estimate: entry.estimate, bytes: written, seconds: took, outcome: "failed")
        try? FileManager.default.removeItem(at: output)
        throw exportFailure(session.error)
      }
      do {
        let size = (try? output.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? Int.max
        let produced = try await AVURLAsset(url: output).load(.duration).seconds
        let whole = produced.isFinite && produced >= seconds - durationSlack
        if whole && size <= limit {
          report(id, preset: entry.preset, estimate: entry.estimate, bytes: size, seconds: took, outcome: "kept")
          // the answer carries which size was kept, so the phone does not depend on the order in which this event and the promise arrive
          return ["uri": output.absoluteString, "size": size, "kept": sizeName(entry.preset), "seconds": took, "estimate": Int(entry.estimate)]
        }
        report(id, preset: entry.preset, estimate: entry.estimate, bytes: size, seconds: took, outcome: whole ? "big" : "cut")
      } catch {
        try? FileManager.default.removeItem(at: output)
        throw error
      }
      try? FileManager.default.removeItem(at: output)
    }
    throw Exception(name: "VideoTooLong", description: "The video does not fit, even at the smallest size.", code: "ERR_VIDEO_TOO_LONG")
  }

  /// What happened at one size, for the phone's performance log (numbers and words only: no name and no path): the size, the system's estimate and what was written in bytes, the seconds it took, and how it ended.
  private func report(_ id: String, preset: String, estimate: Int64, bytes: Int, seconds: Double, outcome: String) {
    sendEvent("onRung", ["id": id, "size": sizeName(preset), "estimate": Int(estimate), "bytes": bytes, "seconds": seconds, "outcome": outcome])
  }

  private func sizeName(_ preset: String) -> String {
    switch preset {
    case AVAssetExportPreset1280x720: return "720p"
    case AVAssetExportPreset960x540: return "540p"
    case AVAssetExportPreset640x480: return "480p"
    case AVAssetExportPresetMediumQuality: return "medium"
    default: return "other"
    }
  }

  /// The system's estimate of the output's size in bytes; 0 when it cannot say.
  private func estimatedLength(of session: AVAssetExportSession) async -> Int64 {
    await withCheckedContinuation { continuation in
      session.estimateOutputFileLength { length, error in
        continuation.resume(returning: error == nil ? length : 0)
      }
    }
  }

  /// A failed export, by its cause where the person can do something about it.
  private func exportFailure(_ error: Error?) -> Exception {
    let cocoa = error as NSError?
    if (error as? AVError)?.code == .diskFull || (cocoa?.domain == NSCocoaErrorDomain && cocoa?.code == NSFileWriteOutOfSpaceError) {
      return Exception(name: "VideoDiskFull", description: "There is not enough space on this phone.", code: "ERR_VIDEO_DISK")
    }
    return Exception(name: "VideoExportFailed", description: error?.localizedDescription ?? "The export did not finish.", code: "ERR_VIDEO_EXPORT")
  }

  /// Why an export was stopped: the person's cancel, or iOS taking the app's background time.
  private func stopReason(_ id: String) -> Exception {
    lock.lock()
    let background = expired.contains(id)
    lock.unlock()
    if background {
      return Exception(name: "VideoBackground", description: "The app was in the background.", code: "ERR_VIDEO_BACKGROUND")
    }
    return Exception(name: "VideoCancelled", description: "Cancelled.", code: "ERR_VIDEO_CANCELLED")
  }

  /// Records the session of an export that is starting; true when it was cancelled before it began. (Locking is done in these plain functions, not in the async ones.)
  private func register(_ session: AVAssetExportSession, id: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    sessions[id] = session
    return cancelled.contains(id)
  }

  private func unregister(_ id: String) {
    lock.lock()
    sessions[id] = nil
    lock.unlock()
  }

  private func markExpired(_ id: String) {
    lock.lock()
    expired.insert(id)
    lock.unlock()
  }

  private func isCancelled(_ id: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return cancelled.contains(id)
  }

  private func stopIfCancelled(_ id: String) throws {
    if isCancelled(id) { throw stopReason(id) }
  }

  private func cancel(_ id: String) {
    lock.lock()
    cancelled.insert(id)
    let session = sessions[id]
    lock.unlock()
    session?.cancelExport()
  }

  private func forget(_ id: String) {
    lock.lock()
    cancelled.remove(id)
    expired.remove(id)
    sessions[id] = nil
    lock.unlock()
  }

  private var manifest: URL { folder.appendingPathComponent("tracked.json") }

  private func readTracked() -> [String: PickerPaths.Tracked] {
    PickerPaths.decodeTracked(try? Data(contentsOf: manifest))
  }

  private func writeTracked(_ tracked: [String: PickerPaths.Tracked]) {
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    if let data = try? JSONEncoder().encode(tracked) { try? data.write(to: manifest, options: .atomic) }
  }

  private func track(_ uris: [String]) {
    lock.lock()
    defer { lock.unlock() }
    var tracked = readTracked()
    let now = Date().timeIntervalSince1970
    // only files of the picker's own folder: a path from anywhere else is not ours to remove later
    for uri in uris {
      if let file = PickerPaths.inside(uri) { tracked[file.absoluteString] = PickerPaths.Tracked(at: now, launch: launch) }
    }
    writeTracked(tracked)
  }

  private func untrack(_ uri: String) {
    lock.lock()
    defer { lock.unlock() }
    var tracked = readTracked()
    let key = PickerPaths.inside(uri)?.absoluteString ?? uri
    guard tracked[key] != nil else { return }
    tracked[key] = nil
    writeTracked(tracked)
  }

  /// Removes the tracked copies an earlier launch left, whatever their age; one of this launch tracked more recently than `staleAfter` may be one a reloaded
  /// app is still reading.
  private func sweepTracked() {
    lock.lock()
    defer { lock.unlock() }
    var tracked = readTracked()
    let now = Date().timeIntervalSince1970
    for (uri, copy) in tracked where PickerPaths.abandoned(copy, launch: launch, now: now, staleAfter: staleAfter) {
      // checked again here: the list is a file on disk, and nothing outside the picker's folder is removed whatever it says
      if let file = PickerPaths.inside(uri) { try? FileManager.default.removeItem(at: file) }
      tracked[uri] = nil
    }
    writeTracked(tracked)
  }

  /// Video files that arrived in the picker's folder more than an hour ago and are not tracked by a pick that is under way; photos and folders are never touched.
  private func sweepPickerVideos() {
    lock.lock()
    let tracked = Set(readTracked().keys)
    lock.unlock()
    for file in PickerPaths.staleVideos(olderThan: staleVideoAfter, skipping: tracked) { try? FileManager.default.removeItem(at: file) }
  }

  /// Our own outputs no export is writing: every partial one an earlier launch left, and one of this launch once it is older than `staleAfter`.
  private func removeStale(in directory: URL) {
    for file in PickerPaths.staleOutputs(in: directory, launch: launch, olderThan: staleAfter, keeping: manifest) {
      try? FileManager.default.removeItem(at: file)
    }
  }
}
