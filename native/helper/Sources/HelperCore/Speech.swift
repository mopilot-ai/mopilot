import Foundation

// Local dictation: which recognizer locale a dictation language setting means.

private let languageLocales: [String: String] = [
    "en": "en-US", "zh": "zh-CN", "es": "es-ES", "fr": "fr-FR", "de": "de-DE", "ja": "ja-JP", "ko": "ko-KR",
    "pt": "pt-BR", "it": "it-IT", "ru": "ru-RU", "ar": "ar-SA", "hi": "hi-IN", "nl": "nl-NL", "tr": "tr-TR",
]

/// A two-letter language ("en", "zh") or a full locale ("en-GB") becomes a recognizer locale identifier;
/// nil, "" or "auto" mean the user's own languages (SFSpeechRecognizer can't detect a language): see autoSpeechLocale.
public func speechLocaleIdentifier(language: String?, system: String, preferred: [String] = [], supported: Set<String> = []) -> String {
    guard let raw = language?.trimmingCharacters(in: .whitespaces), !raw.isEmpty, raw.lowercased() != "auto" else {
        return supported.isEmpty ? plainLocale(system) : autoSpeechLocale(preferred: preferred, system: system, supported: supported)
    }
    let normalized = raw.replacingOccurrences(of: "_", with: "-")
    if normalized.contains("-") { return normalized }
    return languageLocales[normalized.lowercased()] ?? system
}

/// A locale without its "@…" keywords, with "-" between its parts: "en_US@rg=gbzzzz" is "en-US".
public func plainLocale(_ id: String) -> String {
    String(id.split(separator: "@", maxSplits: 1, omittingEmptySubsequences: false).first ?? "").replacingOccurrences(of: "_", with: "-")
}

/// "auto": the first of the user's languages, then the system locale, that the recognizer supports, each matched exactly
/// and then by language (its usual region first: "zh-Hans-US" is zh-CN); en-US when none is.
public func autoSpeechLocale(preferred: [String], system: String, supported: Set<String>) -> String {
    let candidates = (preferred + [system]).map(plainLocale).filter { !$0.isEmpty }
    var known: [String: String] = [:]
    for id in supported.map(plainLocale).sorted() where known[id.lowercased()] == nil { known[id.lowercased()] = id }
    for c in candidates {
        if let hit = known[c.lowercased()] { return hit }
        let lang = c.split(separator: "-").first.map { $0.lowercased() } ?? ""
        if let usual = languageLocales[lang], let hit = known[usual.lowercased()] { return hit }
        if let key = known.keys.sorted().first(where: { $0.hasPrefix(lang + "-") }), let hit = known[key] { return hit }
    }
    return "en-US"
}

/// Audio that came over the socket is a base64 WAV; a sane upper bound keeps one request from filling the disk.
public let maxSpeechAudioBytes = 64 * 1024 * 1024

/// Decodes the audio of a `speech.transcribe` request. Nil when it isn't base64 or is empty or too large.
public func decodeSpeechAudio(_ base64: String?) -> Data? {
    guard let base64, let data = Data(base64Encoded: base64), !data.isEmpty, data.count <= maxSpeechAudioBytes else { return nil }
    return data
}
