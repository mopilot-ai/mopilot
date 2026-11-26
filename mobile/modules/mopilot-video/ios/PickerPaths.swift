// Which files the video module may remove: only files inside the picker's own cache folder, whatever a caller names, only video files for the launch sweep, and what an earlier launch tracked or left half written (#5638).
import Foundation

enum PickerPaths {
  /// Where expo-image-picker writes its copies: its file system's caches directory (no trailing slash, as NSSearchPathForDirectoriesInDomains gives it) plus "ImagePicker".
  static var folder: URL {
    FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("ImagePicker", isDirectory: true)
  }

  /// The file `uri` names, when it is a file URL inside `root` with `..` and symbolic links resolved; nil for anything else (another folder, a sibling whose
  /// name only starts the same, a link that leaves the folder, a URL that is not a file).
  static func inside(_ uri: String, root: URL = folder) -> URL? {
    guard let url = URL(string: uri), url.isFileURL else { return nil }
    let file = url.standardizedFileURL.resolvingSymlinksInPath()
    let base = root.standardizedFileURL.resolvingSymlinksInPath().path
    return file.path.hasPrefix(base + "/") ? file : nil
  }

  static let videoExtensions: Set<String> = ["mov", "mp4", "m4v"]

  /// A video file by its extension; a photo never is. (.qt and .3gp are not named here: a video of one of those is left, never over-removed.)
  static func isVideo(_ url: URL) -> Bool {
    videoExtensions.contains(url.pathExtension.lowercased())
  }

  /// One copy a pick is reading: when it was tracked, and by which launch of the app. A new process cannot have a pick of an earlier one in flight.
  struct Tracked: Codable, Equatable {
    let at: Double
    let launch: String
  }

  /// The tracked copies as the manifest holds them; a manifest of times alone (written before launches were kept) is read as copies of an earlier launch,
  /// and one that cannot be read as none.
  static func decodeTracked(_ data: Data?) -> [String: Tracked] {
    guard let data else { return [:] }
    if let copies = try? JSONDecoder().decode([String: Tracked].self, from: data) { return copies }
    if let times = try? JSONDecoder().decode([String: Double].self, from: data) { return times.mapValues { Tracked(at: $0, launch: "") } }
    return [:]
  }

  /// A tracked copy no pick will read again: every one of an earlier launch (a kill, a crash), and one of this launch (the app's code reloaded) only once it
  /// is older than `staleAfter`, as a pick of this launch may still be reading it.
  static func abandoned(_ copy: Tracked, launch: String, now: Double, staleAfter: Double) -> Bool {
    copy.launch != launch || now - copy.at > staleAfter
  }

  /// An export's file in our own folder is named after the launch that writes it, so a partial one an earlier launch left is known by its name alone.
  static func outputName(launch: String) -> String { "\(launch)-\(UUID().uuidString).mp4" }

  /// The exports of our own `folder` no export is writing: every one an earlier launch made (by its name), and one of this launch only once it was last
  /// written more than `age` seconds before `now`. Only `.mp4` files are exports: `keeping` (the manifest), its temporary copy while it is written, and
  /// folders are never listed.
  static func staleOutputs(in folder: URL, launch: String, olderThan age: TimeInterval, now: Date = Date(), keeping keep: URL) -> [URL] {
    let keys: [URLResourceKey] = [.isRegularFileKey, .contentModificationDateKey]
    let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: keys)) ?? []
    return files.filter { file in
      guard file.lastPathComponent != keep.lastPathComponent, file.pathExtension.lowercased() == "mp4" else { return false }
      guard let values = try? file.resourceValues(forKeys: Set(keys)), values.isRegularFile == true else { return false }
      guard file.lastPathComponent.hasPrefix(launch + "-") else { return true }
      return now.timeIntervalSince(values.contentModificationDate ?? .distantPast) > age
    }
  }

  /// The video files of `root` that arrived more than `age` seconds before `now`, leaving out folders (a folder called x.mov is not removed), photos, and every file in
  /// `tracked` (a pick that is under way). Age is when the file was added to the folder, never its own modification date: a copy may keep the date of the video it was
  /// made of, and a video from last year would look old on arrival. A file with neither date is left.
  static func staleVideos(in root: URL = folder, olderThan age: TimeInterval, now: Date = Date(), skipping tracked: Set<String> = []) -> [URL] {
    let keys: [URLResourceKey] = [.isRegularFileKey, .addedToDirectoryDateKey, .creationDateKey]
    let files = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: keys)) ?? []
    return files.filter { file in
      guard isVideo(file), !tracked.contains(file.standardizedFileURL.resolvingSymlinksInPath().absoluteString) else { return false }
      guard let values = try? file.resourceValues(forKeys: Set(keys)), values.isRegularFile == true else { return false }
      guard let arrived = values.addedToDirectoryDate ?? values.creationDate else { return false }
      return now.timeIntervalSince(arrived) > age
    }
  }
}
