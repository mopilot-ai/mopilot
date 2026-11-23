import Foundation
import XCTest
@testable import HelperCore

final class EventKitTests: XCTestCase {
    func testAuthorizationNamesTreatWriteOnlyAsItsOwnState() {
        XCTAssertEqual((0...4).map(eventKitAuthorizationName), ["notDetermined", "restricted", "denied", "granted", "writeOnly"])
        XCTAssertEqual(eventKitAuthorizationName(99), "notDetermined")
    }

    func testEntityParsingAndNotGrantedNamesTheSettingsPane() {
        XCTAssertEqual(EventKitEntity.parse("calendar"), .calendar)
        XCTAssertEqual(EventKitEntity.parse("reminders"), .reminders)
        XCTAssertNil(EventKitEntity.parse("contacts"))
        XCTAssertNil(EventKitEntity.parse(3))
        XCTAssertEqual(EventKitEntity.calendar.notGranted("denied").reason, "not_granted")
        XCTAssertTrue(EventKitEntity.calendar.notGranted("denied").message.contains("Calendars"))
        XCTAssertTrue(EventKitEntity.reminders.notGranted("denied").message.contains("Reminders"))
        XCTAssertTrue(EventKitEntity.reminders.notGranted("writeOnly").message.contains("System Settings"))
    }

    /// #2999: a source macOS never decided has no entry in the Privacy pane, so the reply does not send the user there; the reason
    /// stays not_granted, which is what makes main show MoMo's own Connect.
    func testNotDeterminedIsNotSentToThePrivacyPane() {
        let calendar = EventKitEntity.calendar.notGranted("notDetermined")
        XCTAssertEqual(calendar.reason, "not_granted")
        XCTAssertTrue(calendar.message.contains("Calendars"))
        XCTAssertFalse(calendar.message.contains("System Settings"))
        XCTAssertTrue(EventKitEntity.reminders.notGranted("notDetermined").message.contains("Connect it again"))
    }

    func testRequestErrorTextIsDomainCodeAndMessage() {
        XCTAssertEqual(eventKitRequestErrorText(domain: "EKErrorDomain", code: 100, message: "Access denied"), "EKErrorDomain 100: Access denied")
    }

    func testRangeNeedsBothEndsInOrderAndAtMostTheMaximum() throws {
        let day = 86_400_000.0
        XCTAssertEqual(try eventKitRange(["start": 0, "end": day]).get().1.timeIntervalSince1970, 86400)
        XCTAssertThrowsError(try eventKitRange(["start": 0]).get())
        XCTAssertThrowsError(try eventKitRange(["start": "0", "end": day]).get())
        XCTAssertThrowsError(try eventKitRange(["start": day, "end": day]).get())
        XCTAssertNoThrow(try eventKitRange(["start": 0, "end": Double(maxEventRangeDays) * day]).get())
        XCTAssertThrowsError(try eventKitRange(["start": 0, "end": Double(maxEventRangeDays) * day + 1]).get())
        XCTAssertNil(eventKitDate(Double.nan))
    }

    func testLimitAndIdsAreClamped() {
        XCTAssertEqual(eventKitLimit([:]), maxEventKitRows)
        XCTAssertEqual(eventKitLimit(["limit": 0]), 1)
        XCTAssertEqual(eventKitLimit(["limit": 7]), 7)
        XCTAssertEqual(eventKitLimit(["limit": 10_000]), maxEventKitRows)
        XCTAssertNil(eventKitIds([:]))
        XCTAssertNil(eventKitIds(["ids": [String]()]))
        XCTAssertEqual(eventKitIds(["ids": ["a", "b", "a"]]), ["a", "b"])
    }

    func testAttendeesAreNamesOnlyNeverEmails() {
        let people = attendeeNames(["Ann Lee", nil, " ", "bob@example.com", " Cy "])
        XCTAssertEqual(people.names, ["Ann Lee", "Cy"])
        XCTAssertEqual(people.others, 3)
    }

    func testEventRowCarriesOnlyTheAllowedFields() {
        let start = Date(timeIntervalSince1970: 1000), end = Date(timeIntervalSince1970: 4600)
        let row = eventRow(title: "Sync", start: start, end: end, allDay: false, location: "Room 1", calendar: "Work",
                           attendees: ["Ann", "x@y.z"])
        XCTAssertEqual(Set(row.keys), ["title", "start", "end", "allDay", "calendar", "attendees", "location", "otherAttendees"])
        XCTAssertEqual(row["start"] as? Double, 1_000_000)
        XCTAssertEqual(row["attendees"] as? [String], ["Ann"])
        XCTAssertEqual(row["otherAttendees"] as? Int, 1)
        let bare = eventRow(title: nil, start: start, end: end, allDay: true, location: "", calendar: "Home", attendees: [])
        XCTAssertEqual(bare["title"] as? String, "")
        XCTAssertNil(bare["location"])
        XCTAssertNil(bare["otherAttendees"])
    }

    func testReminderRowMarksDateOnlyDueAndCompletion() {
        let dateOnly = reminderRow(id: "r1", title: "Pay rent", list: "Home", due: DateComponents(year: 2026, month: 11, day: 1), done: false, completed: nil)
        XCTAssertEqual(dateOnly["dueAllDay"] as? Bool, true)
        XCTAssertNil(dateOnly["completed"])
        let timed = reminderRow(id: "r1", title: nil, list: "Work", due: DateComponents(year: 2026, month: 11, day: 1, hour: 9), done: true,
                                completed: Date(timeIntervalSince1970: 2))
        XCTAssertEqual(timed["dueAllDay"] as? Bool, false)
        XCTAssertEqual(timed["completed"] as? Double, 2000)
        XCTAssertEqual(timed["title"] as? String, "")
        XCTAssertNil(reminderRow(id: "r1", title: "x", list: "l", due: nil, done: false, completed: nil)["due"])
    }

    func testCappedSaysWhenRowsWereLeftOut() {
        let rows: [[String: Any]] = [["a": 1], ["a": 2], ["a": 3]]
        XCTAssertEqual((capped(rows, 2)["items"] as? [[String: Any]])?.count, 2)
        XCTAssertEqual(capped(rows, 2)["truncated"] as? Bool, true)
        XCTAssertEqual(capped(rows, 3)["truncated"] as? Bool, false)
    }

    func testQueriesCarryTheParsedRangeIdsAndLimit() throws {
        let q = try eventQuery(["start": 0, "end": 3_600_000, "ids": ["a"], "limit": 3]).get()
        XCTAssertEqual(q, EventQuery(start: Date(timeIntervalSince1970: 0), end: Date(timeIntervalSince1970: 3600), ids: ["a"], limit: 3))
        XCTAssertThrowsError(try eventQuery(["start": 0]).get())
        XCTAssertEqual(reminderQuery(["completedSince": 1000]), ReminderQuery(ids: nil, completedSince: Date(timeIntervalSince1970: 1), limit: maxEventKitRows))
        XCTAssertNil(reminderQuery([:]).completedSince)
    }

    func testRemindersKeepOpenOnesFirstSoonestDueThenRecentlyDone() {
        let rows: [[String: Any]] = [
            ["title": "old done", "done": true, "completed": 1.0],
            ["title": "no due", "done": false],
            ["title": "later", "done": false, "due": 20.0],
            ["title": "recent done", "done": true, "completed": 5.0],
            ["title": "b soon", "done": false, "due": 10.0],
            ["title": "a soon", "done": false, "due": 10.0],
        ]
        XCTAssertEqual(sortedReminderRows(rows).map { $0["title"] as? String }, ["a soon", "b soon", "later", "no due", "recent done", "old done"])
        // a row missing its fields sorts as open with no due date and no title; a done one without a time goes last
        XCTAssertEqual(sortedReminderRows([["done": true, "title": "x"], [:], ["title": "z", "done": false]]).map { $0["title"] as? String },
                       [nil, "z", "x"])
        // the limit then keeps the useful ones
        XCTAssertEqual(((capped(sortedReminderRows(rows), 2)["items"]) as? [[String: Any]])?.map { $0["title"] as? String }, ["a soon", "b soon"])
    }

    func testReminderDueInItsOwnTimeZone() {
        var due = DateComponents(year: 2026, month: 11, day: 1, hour: 9)
        due.timeZone = TimeZone(identifier: "UTC")
        let row = reminderRow(id: "r1", title: "Call", list: "Work", due: due, done: false, completed: nil)
        XCTAssertEqual(row["due"] as? Double, 1_793_523_600_000)
        XCTAssertEqual(row["dueAllDay"] as? Bool, false)
    }

    // MARK: writes

    func testProtocolIsTwoAndRowsCarryTheId() {
        XCTAssertEqual(eventKitProtocol, 2)
        XCTAssertEqual(reminderRow(id: "r9", title: "x", list: "l", due: nil, done: false, completed: nil)["id"] as? String, "r9")
    }

    func testEventCreateParsesAndRejects() throws {
        let ok = try eventCreate(["title": " Dentist ", "start": 1000, "end": 4600, "allDay": false, "calendarId": "c1", "location": "Main St"]).get()
        XCTAssertEqual(ok, EventCreate(title: "Dentist", start: Date(timeIntervalSince1970: 1), end: Date(timeIntervalSince1970: 4.6), allDay: false, calendarId: "c1", location: "Main St"))
        let bare = try eventCreate(["title": "x", "start": 0, "end": 1, "allDay": true, "calendarId": NSNull()]).get()
        XCTAssertNil(bare.calendarId)
        XCTAssertNil(bare.location)
        let base: [String: Any] = ["title": "x", "start": 0, "end": 1000, "allDay": false]
        let bads: [(String, Any)] = [("title", ""), ("title", 3), ("start", "0"), ("end", 0), ("allDay", 1), ("calendarId", ""), ("location", 5)]
        for (key, bad) in bads {
            var p = base
            p[key] = bad
            XCTAssertEqual(eventCreate(p).failureReason, "bad_args", "\(key)=\(bad)")
        }
        var missing = base
        missing["allDay"] = nil
        XCTAssertEqual(eventCreate(missing).failureReason, "bad_args")
    }

    func testReminderDueIsDateOnlyOrWithTime() {
        let date = Calendar.current.date(from: DateComponents(year: 2026, month: 11, day: 11, hour: 9, minute: 30))!
        let dayOnly = reminderDueComponents(date, allDay: true)
        XCTAssertEqual([dayOnly.year, dayOnly.month, dayOnly.day], [2026, 11, 11])
        XCTAssertNil(dayOnly.hour)
        let timed = reminderDueComponents(date, allDay: false)
        XCTAssertEqual([timed.hour, timed.minute], [9, 30])
    }

    func testReminderCreateParsesDueAndList() throws {
        let ms = Calendar.current.date(from: DateComponents(year: 2026, month: 11, day: 11, hour: 9))!.timeIntervalSince1970 * 1000
        let timed = try reminderCreate(["title": "Call", "due": ms, "listId": "l1"]).get()
        XCTAssertEqual(timed.due?.hour, 9)
        XCTAssertEqual(timed.listId, "l1")
        let allDay = try reminderCreate(["title": "Call", "due": ms, "dueAllDay": true]).get()
        XCTAssertNil(allDay.due?.hour)
        XCTAssertEqual(allDay.due?.day, 11)
        let none = try reminderCreate(["title": "Call", "due": NSNull(), "dueAllDay": NSNull()]).get()
        XCTAssertNil(none.due)
        XCTAssertNil(none.listId)
        let nullFlag = try reminderCreate(["title": "Call", "due": ms, "dueAllDay": NSNull()]).get()
        XCTAssertEqual(nullFlag.due?.hour, 9)
        XCTAssertEqual(reminderCreate(["title": " "]).failureReason, "bad_args")
        XCTAssertEqual(reminderCreate(["title": "x", "due": "soon"]).failureReason, "bad_args")
        XCTAssertEqual(reminderCreate(["title": "x", "due": ms, "dueAllDay": "yes"]).failureReason, "bad_args")
        XCTAssertEqual(reminderCreate(["title": "x", "listId": ""]).failureReason, "bad_args")
    }

    func testIdAndExpectParsing() throws {
        XCTAssertEqual(try eventKitItemId(["id": "a"]).get(), "a")
        XCTAssertEqual(eventKitItemId(["id": ""]).failureReason, "bad_args")
        XCTAssertEqual(eventKitItemId([:]).failureReason, "bad_args")
        XCTAssertEqual(try eventKitExpect(["expect": ["title": "T"]], needsStart: false).get(), Expect(title: "T", start: nil))
        XCTAssertEqual(try eventKitExpect(["expect": ["title": "T", "start": 2000]], needsStart: true).get().start, Date(timeIntervalSince1970: 2))
        XCTAssertEqual(eventKitExpect(["expect": ["title": "T"]], needsStart: true).failureReason, "bad_args")
        XCTAssertEqual(eventKitExpect(["expect": ["start": 1]], needsStart: false).failureReason, "bad_args")
        XCTAssertEqual(eventKitExpect([:], needsStart: false).failureReason, "bad_args")
    }

    func testCompleteAndDeleteParsing() throws {
        let c = try reminderComplete(["id": "r", "done": true, "expect": ["title": "T"]]).get()
        XCTAssertEqual(c, ReminderComplete(id: "r", done: true, expect: Expect(title: "T", start: nil)))
        XCTAssertEqual(reminderComplete(["id": "r", "done": "true", "expect": ["title": "T"]]).failureReason, "bad_args")
        XCTAssertEqual(reminderComplete(["done": true, "expect": ["title": "T"]]).failureReason, "bad_args")
        XCTAssertEqual(reminderComplete(["id": "r", "done": true]).failureReason, "bad_args")
        let d = try eventKitDelete(["id": "e", "expect": ["title": "T", "start": 5000]], needsStart: true).get()
        XCTAssertEqual(d.id, "e")
        XCTAssertEqual(d.expect.start, Date(timeIntervalSince1970: 5))
        XCTAssertEqual(try eventKitDelete(["id": "e", "expect": ["title": "T"]], needsStart: false).get().expect.title, "T")
        XCTAssertEqual(eventKitDelete(["expect": ["title": "T"]], needsStart: false).failureReason, "bad_args")
    }

    func testMatchesTitleAndStartWithinASecond() {
        let t = Date(timeIntervalSince1970: 100)
        let ev = Expect(title: "T", start: t)
        XCTAssertTrue(eventKitMatches(ev, title: "T", start: t.addingTimeInterval(0.9)))
        XCTAssertFalse(eventKitMatches(ev, title: "T", start: t.addingTimeInterval(1.5)))
        XCTAssertFalse(eventKitMatches(ev, title: "T"))
        XCTAssertFalse(eventKitMatches(ev, title: "U", start: t))
        XCTAssertTrue(eventKitMatches(Expect(title: "", start: nil), title: nil))
        XCTAssertFalse(eventKitMatches(Expect(title: "T", start: nil), title: nil))
    }

    func testWriteErrorReasonsAndReplies() {
        XCTAssertEqual(eventKitReadOnly("calendar").reason, "read_only")
        XCTAssertTrue(eventKitReadOnly("list").message.contains("list"))
        XCTAssertEqual([eventKitBadArgs("x"), eventKitNotFound("x"), eventKitChanged, eventKitGone].map { $0.reason },
                       ["bad_args", "not_found", "changed", "gone"])
        XCTAssertEqual(eventKitCreated(id: "i", container: "Work", key: "calendar") as? [String: String], ["id": "i", "calendar": "Work"])
        XCTAssertEqual(reminderGetRow(id: "i", title: nil, list: "L", done: true)["title"] as? String, "")
        XCTAssertEqual(reminderGetRow(id: "i", title: "T", list: "L", done: false)["done"] as? Bool, false)
    }
}

private extension Result where Failure == HelperError {
    var failureReason: String? { if case .failure(let e) = self { return e.reason } else { return nil } }
}
