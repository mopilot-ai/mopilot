import Foundation
import XCTest
@testable import HelperCore

final class SpeechStreamCoreTests: XCTestCase {
    func testPCMFramesDecodeLittleEndianAndRefuseWhatIsNotAFrame() {
        XCTAssertEqual(decodePCMFrame(Data([0x01, 0x00, 0xFF, 0xFF, 0x00, 0x80]).base64EncodedString()), [1, -1, -32768])
        XCTAssertNil(decodePCMFrame(nil))
        XCTAssertNil(decodePCMFrame("not base64!"))
        XCTAssertNil(decodePCMFrame(""))
        XCTAssertNil(decodePCMFrame(Data([1, 2, 3]).base64EncodedString()))
        XCTAssertNil(decodePCMFrame(Data(count: maxSpeechFrameBytes + 2).base64EncodedString()))
        XCTAssertEqual(decodePCMFrame(Data(count: maxSpeechFrameBytes).base64EncodedString())?.count, maxSpeechFrameBytes / 2)
    }

    func testStreamTextKeepsFinishedRequestsAndTheCurrentGuess() {
        var t = SpeechStreamText()
        XCTAssertEqual(t.text, "")
        t.guess("hello wor")
        XCTAssertEqual(t.text, "hello wor")
        t.commit(" hello world ")
        XCTAssertEqual(t.current, "")
        t.guess("again")
        XCTAssertEqual(t.text, "hello world again")
        t.commit("")
        XCTAssertEqual(t.done, ["hello world"])
        XCTAssertEqual(t.text, "hello world")
    }
}
