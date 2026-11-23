import Foundation

// Streaming dictation, the parts that need no recognizer: the PCM frames main sends and the text a session has so far.

/// One frame is 16 kHz mono 16-bit PCM; a frame over a second is refused (main sends about 100 ms at a time).
public let speechStreamRate: Double = 16_000
public let maxSpeechFrameBytes = 32_000 * 2

/// The samples of a `speech.stream.append` frame (base64, little-endian Int16). Nil when it isn't base64, is empty, has
/// an odd byte or is too long.
public func decodePCMFrame(_ base64: String?) -> [Int16]? {
    guard let base64, let data = Data(base64Encoded: base64), !data.isEmpty, data.count % 2 == 0, data.count <= maxSpeechFrameBytes
    else { return nil }
    return data.withUnsafeBytes { raw in (0..<data.count / 2).map { Int16(littleEndian: raw.load(fromByteOffset: $0 * 2, as: Int16.self)) } }
}

/// What a session has heard: the text of the recognition requests it already finished (a long pause ends one and the
/// session starts the next) and the current request's latest guess, joined with a space.
public struct SpeechStreamText: Equatable {
    public private(set) var done: [String] = []
    public private(set) var current = ""

    public init() {}

    /// The current request's newest guess (partial results replace each other).
    public mutating func guess(_ text: String) { current = text }

    /// The current request ended with `text`: it is kept, and the next request starts empty.
    public mutating func commit(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespaces)
        if !t.isEmpty { done.append(t) }
        current = ""
    }

    public var text: String {
        (done + [current.trimmingCharacters(in: .whitespaces)]).filter { !$0.isEmpty }.joined(separator: " ")
    }
}
