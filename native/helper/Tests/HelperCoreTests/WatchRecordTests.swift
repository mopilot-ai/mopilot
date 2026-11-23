// Watch-and-record's key naming: text typed, shortcuts and named keys, and what is not kept.
import XCTest
@testable import HelperCore

final class WatchRecordTests: XCTestCase {
    private let cmd: UInt64 = 0x100000
    private let shift: UInt64 = 0x20000
    private let alt: UInt64 = 0x80000
    private let ctrl: UInt64 = 0x40000

    func testPrintableKeysAreTextTyped() {
        XCTAssertEqual(recordKey(keyCode: 0, flags: 0, characters: "a", unshifted: "a"), .text("a"))
        XCTAssertEqual(recordKey(keyCode: 0, flags: shift, characters: "A", unshifted: "a"), .text("A"))
        XCTAssertEqual(recordKey(keyCode: 49, flags: 0, characters: " ", unshifted: " "), .text(" "))
        XCTAssertEqual(recordKey(keyCode: 0, flags: 0, characters: "é", unshifted: "e"), .text("é"))
    }

    func testShortcutsAreCombosInInputKeyNames() {
        XCTAssertEqual(recordKey(keyCode: 17, flags: cmd | shift, characters: "T", unshifted: "t"), .combo("shift+cmd+t"))
        XCTAssertEqual(recordKey(keyCode: 0, flags: cmd, characters: "a", unshifted: "a"), .combo("cmd+a"))
        XCTAssertEqual(recordKey(keyCode: 8, flags: ctrl | alt, characters: "c", unshifted: "C"), .combo("ctrl+alt+c"))
        XCTAssertEqual(recordKey(keyCode: 36, flags: cmd, characters: "\r", unshifted: "\r"), .combo("cmd+return"))
    }

    func testNamedKeysAreCombosWithoutModifiers() {
        XCTAssertEqual(recordKey(keyCode: 36, flags: 0, characters: "\r", unshifted: "\r"), .combo("return"))
        XCTAssertEqual(recordKey(keyCode: 76, flags: 0, characters: "\r", unshifted: "\r"), .combo("return"))
        XCTAssertEqual(recordKey(keyCode: 48, flags: shift, characters: "\t", unshifted: "\t"), .combo("shift+tab"))
        XCTAssertEqual(recordKey(keyCode: 51, flags: 0, characters: "\u{7f}", unshifted: "\u{7f}"), .combo("delete"))
        XCTAssertEqual(recordKey(keyCode: 125, flags: 0, characters: nil, unshifted: nil), .combo("down"))
        XCTAssertEqual(recordKey(keyCode: 122, flags: 0, characters: nil, unshifted: nil), .combo("f1"))
    }

    func testWhatIsNotWorthKeepingIsDropped() {
        // a control character with nothing named for it, and a key that typed nothing
        XCTAssertNil(recordKey(keyCode: 200, flags: 0, characters: "\u{1}", unshifted: nil))
        XCTAssertNil(recordKey(keyCode: 200, flags: 0, characters: "", unshifted: nil))
        XCTAssertNil(recordKey(keyCode: 200, flags: 0, characters: nil, unshifted: nil))
        // a shortcut whose key has no name (a dead key, several characters)
        XCTAssertNil(recordKey(keyCode: 200, flags: cmd, characters: "ab", unshifted: "ab"))
        XCTAssertNil(recordKey(keyCode: 200, flags: cmd, characters: "\u{1}", unshifted: "\u{1}"))
        XCTAssertNil(recordKey(keyCode: 200, flags: cmd, characters: nil, unshifted: nil))
    }

    func testModifierNamesFollowInputKeyOrder() {
        XCTAssertEqual(recordedModifiers(0), [])
        XCTAssertEqual(recordedModifiers(cmd | shift | alt | ctrl), ["ctrl", "alt", "shift", "cmd"])
    }
}
