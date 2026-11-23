import CoreGraphics
import Foundation
import HelperCore
import Vision

/// Text lines Vision finds in `shot`, as elements in global points. Runs on-device.
func recognizeText(in shot: AppShot) throws -> [UIElement] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.automaticallyDetectsLanguage = true
    try VNImageRequestHandler(cgImage: shot.image, options: [:]).perform([request])
    var out: [UIElement] = []
    for (i, obs) in (request.results ?? []).enumerated() {
        guard let best = obs.topCandidates(1).first, !best.string.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
        let frame = visionRectToPoints(obs.boundingBox, imageWidth: shot.image.width, imageHeight: shot.image.height,
                                       origin: shot.frame.origin, pixelsPerPoint: shot.pixelsPerPoint)
        out.append(UIElement(id: "ocr:\(i)", text: String(best.string.prefix(200)), role: "text", frame: frame, source: "ocr", confidence: Double(best.confidence)))
    }
    return out
}
