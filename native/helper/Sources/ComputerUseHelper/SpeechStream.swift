import AVFoundation
import Foundation
import HelperCore
import Speech

/// Streaming dictation on device: main sends the microphone as 16 kHz PCM frames (`speech.stream.append`) and is told
/// each new guess (`speech.stream.result`); `speech.stream.finish` answers the final text. Audio never leaves the Mac.
/// A long pause can end the recognizer's request: the session keeps what it heard and listens on with a new one.
final class SpeechStreams {
    private final class Session {
        let recognizer: SFSpeechRecognizer
        var request: SFSpeechAudioBufferRecognitionRequest
        var task: SFSpeechRecognitionTask?
        var text = SpeechStreamText()
        var finishing: ((String) -> Void)?
        /// requests in a row that ended in an error before hearing anything
        var failures = 0
        init(_ recognizer: SFSpeechRecognizer) {
            self.recognizer = recognizer
            request = SpeechStreams.request()
        }
    }

    private var sessions: [String: Session] = [:]
    private let queue = DispatchQueue(label: "speech.stream")
    private let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: speechStreamRate, channels: 1, interleaved: false)!
    /// how long `finish` waits for the recognizer's last word before answering with what it has
    var finishTimeout: TimeInterval = 10
    var notify: (String, [String: Any]) -> Void = { _, _ in }

    private static func request() -> SFSpeechAudioBufferRecognitionRequest {
        let r = SFSpeechAudioBufferRecognitionRequest()
        r.shouldReportPartialResults = true
        r.requiresOnDeviceRecognition = true
        if #available(macOS 13, *) { r.addsPunctuation = true }
        return r
    }

    func dispatch(_ method: String, _ params: [String: Any], _ reply: @escaping (Result<Any, HelperError>) -> Void) {
        guard let id = params["session"] as? String, !id.isEmpty else { return reply(.failure(.invalidParams("session"))) }
        switch method {
        case "speech.stream.start":
            do { reply(.success(try start(id, language: params["language"] as? String))) } catch let e as HelperError { reply(.failure(e)) } catch {
                reply(.failure(HelperError(-32603, "internal", error.localizedDescription)))
            }
        case "speech.stream.append":
            guard let samples = decodePCMFrame(params["pcm"] as? String) else { return reply(.failure(.invalidParams("pcm must be 16-bit PCM, base64"))) }
            reply(append(id, samples) ? .success(["ok": true]) : .failure(HelperError(9, "no_session", "this dictation stream has ended")))
        case "speech.stream.finish":
            finish(id) { reply(.success(["text": $0])) }
        default:
            cancel(id)
            reply(.success(["ok": true]))
        }
    }

    private func start(_ id: String, language: String?) throws -> [String: Any] {
        guard speechAuthorization() == "authorized" else { throw HelperError(1, "permission_denied", "speech recognition permission not granted") }
        let locale = recognizerLocale(language)
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)), recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else {
            throw HelperError(9, "speech_unavailable", "\(locale) isn't available for on-device recognition")
        }
        queue.sync {
            sessions[id]?.task?.cancel()
            let s = Session(recognizer)
            sessions[id] = s
            listen(id, s)
        }
        return ["locale": locale]
    }

    /// On the queue: a recognition task for the session's current request.
    private func listen(_ id: String, _ s: Session) {
        let request = s.request
        s.task = s.recognizer.recognitionTask(with: request) { [weak self] result, error in
            self?.queue.async { self?.heard(id, request, result, error) }
        }
    }

    private func heard(_ id: String, _ request: SFSpeechAudioBufferRecognitionRequest, _ result: SFSpeechRecognitionResult?, _ error: Error?) {
        // an older request's late answer changes nothing
        guard let s = sessions[id], s.request === request else { return }
        if let result {
            s.failures = 0
            let words = result.bestTranscription.formattedString
            if result.isFinal { s.text.commit(words) } else { s.text.guess(words) }
            notify("speech.stream.result", ["session": id, "text": s.text.text])
        }
        guard error != nil || result?.isFinal == true else { return }
        if let done = s.finishing {
            sessions[id] = nil
            return done(s.text.text)
        }
        // a request that ended without a final result keeps its last guess before the next one starts
        if result?.isFinal != true { s.text.commit(s.text.current) }
        if error != nil, result == nil {
            s.failures += 1
            if s.failures >= 3 {
                sessions[id] = nil
                return notify("speech.stream.error", ["session": id, "message": error!.localizedDescription])
            }
        }
        // the request ended before the dictation did (a long pause): keep listening with a new one
        s.request = Self.request()
        listen(id, s)
    }

    private func append(_ id: String, _ samples: [Int16]) -> Bool {
        queue.sync {
            guard let s = sessions[id], s.finishing == nil,
                  let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)) else { return false }
            buffer.frameLength = AVAudioFrameCount(samples.count)
            let out = buffer.floatChannelData![0]
            for (i, v) in samples.enumerated() { out[i] = Float(v) / 32768 }
            s.request.append(buffer)
            return true
        }
    }

    private func finish(_ id: String, _ done: @escaping (String) -> Void) {
        queue.async { [self] in
            guard let s = sessions[id] else { return done("") }
            var answered = false
            let once: (String) -> Void = { text in
                if answered { return }
                answered = true
                done(text)
            }
            s.finishing = once
            s.request.endAudio()
            queue.asyncAfter(deadline: .now() + finishTimeout) { [weak self] in
                guard let self, let s = self.sessions[id], s.finishing != nil else { return }
                self.sessions[id] = nil
                s.task?.cancel()
                once(s.text.text)
            }
        }
    }

    private func cancel(_ id: String) {
        queue.sync {
            sessions[id]?.task?.cancel()
            sessions[id] = nil
        }
    }
}
