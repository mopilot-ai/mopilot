// A small program that checks PickerPaths against a real folder: run by tests/mopilotVideoPaths.test.ts after compiling it with the module's own PickerPaths.swift.
import Foundation

@main
struct PickerPathsDriver {
  static func main() {
      var failures: [String] = []
      func check(_ ok: Bool, _ what: String) { if !ok { failures.append(what) } }

      let manager = FileManager.default
      let base = manager.temporaryDirectory.appendingPathComponent("pickerpaths-\(UUID().uuidString)", isDirectory: true)
      let root = base.appendingPathComponent("ImagePicker", isDirectory: true)
      let outside = base.appendingPathComponent("elsewhere", isDirectory: true)
      let sibling = base.appendingPathComponent("ImagePicker2", isDirectory: true)
      for folder in [root, outside, sibling] { try! manager.createDirectory(at: folder, withIntermediateDirectories: true) }
      let video = root.appendingPathComponent("a.mov")
      manager.createFile(atPath: video.path, contents: Data([1]))
      manager.createFile(atPath: outside.appendingPathComponent("b.mov").path, contents: Data([1]))
      manager.createFile(atPath: sibling.appendingPathComponent("c.mov").path, contents: Data([1]))
      try! manager.createSymbolicLink(at: root.appendingPathComponent("link.mov"), withDestinationURL: outside.appendingPathComponent("b.mov"))

      check(PickerPaths.inside(video.absoluteString, root: root) != nil, "a file in the folder is inside")
      check(PickerPaths.inside(root.appendingPathComponent("not-made-yet.mp4").absoluteString, root: root) != nil, "a file that is not there yet is inside by its place")
      check(PickerPaths.inside(outside.appendingPathComponent("b.mov").absoluteString, root: root) == nil, "a file of another folder is not")
      check(PickerPaths.inside("file:///etc/passwd", root: root) == nil, "a system file is not")
      check(PickerPaths.inside(root.absoluteString + "../elsewhere/b.mov", root: root) == nil, "a path that climbs out with .. is not")
      check(PickerPaths.inside(root.absoluteString + "x/../../elsewhere/b.mov", root: root) == nil, "a path that goes in and climbs out is not")
      check(PickerPaths.inside(sibling.appendingPathComponent("c.mov").absoluteString, root: root) == nil, "a sibling folder whose name starts the same is not")
      check(PickerPaths.inside(root.absoluteString, root: root) == nil, "the folder itself is not a file of it")
      check(PickerPaths.inside(root.appendingPathComponent("link.mov").absoluteString, root: root) == nil, "a link that leaves the folder is not")
      check(PickerPaths.inside("https://example.com/a.mov", root: root) == nil, "a URL that is not a file is not")
      check(PickerPaths.inside("not a url at all", root: root) == nil, "text that is not a URL is not")
      check(PickerPaths.isVideo(URL(fileURLWithPath: "/x/a.MOV")) && PickerPaths.isVideo(URL(fileURLWithPath: "/x/a.mp4")) && PickerPaths.isVideo(URL(fileURLWithPath: "/x/a.m4v")), "videos are videos, whatever the case")
      check(!PickerPaths.isVideo(URL(fileURLWithPath: "/x/a.jpg")) && !PickerPaths.isVideo(URL(fileURLWithPath: "/x/a.heic")) && !PickerPaths.isVideo(URL(fileURLWithPath: "/x/a")), "a photo never is")

      // the launch sweep's choice: videos only, regular files only, none that a pick under way tracks, by when they arrived and not by their own dates
      let sweepRoot = base.appendingPathComponent("sweep", isDirectory: true)
      try! manager.createDirectory(at: sweepRoot, withIntermediateDirectories: true)
      manager.createFile(atPath: sweepRoot.appendingPathComponent("plain.mov").path, contents: Data([1]))
      manager.createFile(atPath: sweepRoot.appendingPathComponent("year-old-copy.mp4").path, contents: Data([1]))
      try! manager.setAttributes([.modificationDate: Date(timeIntervalSince1970: 1_000_000_000), .creationDate: Date(timeIntervalSince1970: 1_000_000_000)], ofItemAtPath: sweepRoot.appendingPathComponent("year-old-copy.mp4").path)
      manager.createFile(atPath: sweepRoot.appendingPathComponent("tracked.m4v").path, contents: Data([1]))
      manager.createFile(atPath: sweepRoot.appendingPathComponent("photo.jpg").path, contents: Data([1]))
      manager.createFile(atPath: sweepRoot.appendingPathComponent("unknown.qt").path, contents: Data([1]))
      try! manager.createDirectory(at: sweepRoot.appendingPathComponent("folder.mov", isDirectory: true), withIntermediateDirectories: true)
      let tracked: Set<String> = [sweepRoot.appendingPathComponent("tracked.m4v").standardizedFileURL.resolvingSymlinksInPath().absoluteString]
      let names = { (urls: [URL]) in urls.map { $0.lastPathComponent }.sorted() }
      check(names(PickerPaths.staleVideos(in: sweepRoot, olderThan: -1, skipping: tracked)) == ["plain.mov", "year-old-copy.mp4"], "everything old enough, videos only, regular files only, none tracked: \(names(PickerPaths.staleVideos(in: sweepRoot, olderThan: -1, skipping: tracked)))")
      check(PickerPaths.staleVideos(in: sweepRoot, olderThan: 3600).isEmpty, "a file that arrived a moment ago is not old, even when its own dates are from the year 2001")
      check(PickerPaths.staleVideos(in: sweepRoot.appendingPathComponent("nothing-here"), olderThan: -1).isEmpty, "a folder that is not there has nothing")

      // what a kill leaves (#5638 device row): a tracked copy and a half-written export of an earlier launch go at the next launch whatever their age;
      // within this launch (the app's code reloaded) only once they are old
      let now = Date().timeIntervalSince1970
      let fresh = PickerPaths.Tracked(at: now - 5, launch: "B")
      check(PickerPaths.abandoned(PickerPaths.Tracked(at: now - 5, launch: "A"), launch: "B", now: now, staleAfter: 600), "a copy an earlier launch tracked a moment ago is abandoned")
      check(!PickerPaths.abandoned(fresh, launch: "B", now: now, staleAfter: 600), "a copy this launch tracked a moment ago is not")
      check(PickerPaths.abandoned(PickerPaths.Tracked(at: now - 601, launch: "B"), launch: "B", now: now, staleAfter: 600), "a copy this launch tracked long ago is")
      let encoded = try! JSONEncoder().encode(["file:///a.mov": fresh])
      check(PickerPaths.decodeTracked(encoded) == ["file:///a.mov": fresh], "the manifest reads back what was written")
      check(PickerPaths.decodeTracked(Data("{\"file:///b.mov\": 12.5}".utf8)) == ["file:///b.mov": PickerPaths.Tracked(at: 12.5, launch: "")], "a manifest of times alone is of an earlier launch")
      check(PickerPaths.decodeTracked(Data("not json".utf8)).isEmpty && PickerPaths.decodeTracked(nil).isEmpty, "a manifest that cannot be read, or none, holds nothing")

      let outputs = base.appendingPathComponent("mopilot-video", isDirectory: true)
      try! manager.createDirectory(at: outputs, withIntermediateDirectories: true)
      let mine = PickerPaths.outputName(launch: "B")
      check(mine.hasPrefix("B-") && mine.hasSuffix(".mp4") && mine != PickerPaths.outputName(launch: "B"), "an output is named after its launch, and each is new: \(mine)")
      // an atomic write of the manifest goes through a temporary file next to it: it is never an export, whatever its name
      for name in [mine, "A-partial.mp4", "0F1E-old-build.mp4", "tracked.json", "A-tracked.json.tmp", ".dat.nosync1A2B"] {
        manager.createFile(atPath: outputs.appendingPathComponent(name).path, contents: Data())
      }
      try! manager.createDirectory(at: outputs.appendingPathComponent("A-folder", isDirectory: true), withIntermediateDirectories: true)
      let keep = outputs.appendingPathComponent("tracked.json")
      check(names(PickerPaths.staleOutputs(in: outputs, launch: "B", olderThan: 600, keeping: keep)) == ["0F1E-old-build.mp4", "A-partial.mp4"], "an earlier launch's exports go at once, this launch's young one stays; the manifest, its temporary copy, other files and folders are never listed: \(names(PickerPaths.staleOutputs(in: outputs, launch: "B", olderThan: 600, keeping: keep)))")
      check(names(PickerPaths.staleOutputs(in: outputs, launch: "B", olderThan: -1, keeping: keep)).contains(mine), "this launch's output goes once it is old")

      try? manager.removeItem(at: base)
      if failures.isEmpty { print("OK") } else {
        print("FAILED: " + failures.joined(separator: "; "))
        exit(1)
      }
  }
}
