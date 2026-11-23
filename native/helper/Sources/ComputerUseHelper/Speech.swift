import Foundation
import HelperCore
import Speech

/// Local dictation through SFSpeechRecognizer, on device only: audio never goes to Apple's servers.

func speechAuthorization() -> String {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "notDetermined"
    }
}

/// Shows the system prompt the first time; afterwards macOS just answers.
func requestSpeechAuthorization() async -> String {
    if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            SFSpeechRecognizer.requestAuthorization { _ in c.resume() }
        }
    }
    return speechAuthorization()
}

/// The recognizer locale for a dictation language, "auto" resolved against what this Mac can recognize.
func recognizerLocale(_ language: String?) -> String {
    speechLocaleIdentifier(
        language: language, system: Locale.current.identifier, preferred: Locale.preferredLanguages,
        supported: Set(SFSpeechRecognizer.supportedLocales().map(\.identifier)))
}

func speechStatus(language: String?) -> [String: Any] {
    let id = recognizerLocale(language)
    let recognizer = SFSpeechRecognizer(locale: Locale(identifier: id))
    return [
        "authorization": speechAuthorization(),
        "locale": id,
        "available": recognizer?.isAvailable ?? false,
        "onDevice": recognizer?.supportsOnDeviceRecognition ?? false,
    ]
}

/// Transcribes one WAV (or any file AVFoundation reads). Throws a HelperError the client can show.
func transcribeSpeech(audio: Data, language: String?) async throws -> [String: Any] {
    guard await requestSpeechAuthorization() == "authorized" else { throw HelperError(1, "permission_denied", "speech recognition permission not granted") }
    let id = recognizerLocale(language)
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: id)), recognizer.isAvailable else {
        throw HelperError(9, "speech_unavailable", "speech recognition isn't available for \(id)")
    }
    guard recognizer.supportsOnDeviceRecognition else {
        throw HelperError(9, "speech_unavailable", "\(id) isn't available for on-device recognition; pick another dictation engine or download the language in System Settings")
    }
    let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("mpcu-\(UUID().uuidString).wav")
    try audio.write(to: url, options: .atomic)
    defer { try? FileManager.default.removeItem(at: url) }

    let request = SFSpeechURLRecognitionRequest(url: url)
    request.requiresOnDeviceRecognition = true
    request.shouldReportPartialResults = false
    let text: String = try await withCheckedThrowingContinuation { c in
        var done = false
        let lock = NSLock()
        recognizer.recognitionTask(with: request) { result, error in
            lock.lock(); defer { lock.unlock() }
            if done { return }
            if let error {
                done = true
                // no words in the clip is an answer (nothing to type), not a failure to retry
                let e = error as NSError
                if e.domain == "kAFAssistantErrorDomain" && e.code == 1110 { return c.resume(returning: "") }
                c.resume(throwing: HelperError(9, "speech_failed", error.localizedDescription))
            } else if let result, result.isFinal {
                done = true
                c.resume(returning: result.bestTranscription.formattedString)
            }
        }
    }
    return ["text": text, "locale": id]
}

/// The streaming dictation sessions (SpeechStream.swift), one set for the helper's life.
private let speechStreams = SpeechStreams()

/// Runs one dictation command (`speech.status`, `speech.request`, `speech.transcribe`, `speech.stream.*`) and replies;
/// `notify` carries a stream's guesses to main.
func dispatchSpeech(
    _ method: String, _ params: [String: Any], _ reply: @escaping (Result<Any, HelperError>) -> Void,
    notify: @escaping (String, [String: Any]) -> Void
) {
    if method.hasPrefix("speech.stream.") {
        speechStreams.notify = notify
        return speechStreams.dispatch(method, params, reply)
    }
    let language = params["language"] as? String
    switch method {
    case "speech.status":
        reply(.success(speechStatus(language: language)))
    case "speech.request":
        Task.detached {
            _ = await requestSpeechAuthorization()
            reply(.success(speechStatus(language: language)))
        }
    default:
        guard let audio = decodeSpeechAudio(params["audio"] as? String) else { return reply(.failure(.invalidParams("audio must be non-empty base64"))) }
        Task.detached {
            do { reply(.success(try await transcribeSpeech(audio: audio, language: language))) } catch let e as HelperError { reply(.failure(e)) } catch {
                reply(.failure(HelperError(-32603, "internal", error.localizedDescription)))
            }
        }
    }
}
