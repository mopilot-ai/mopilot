import Foundation

// MoMo's Calendar and Reminders commands (#2139 P2 reads, P5 writes): the pure part of the EventKit commands. Which
// authorization a raw EventKit status means, the time range and limits a request may ask for, the rows main gets (titles,
// times, location, calendar and attendees' names only, never their emails or the event's notes and URLs), and the parsing
// of the write commands' parameters (create, complete, delete). Writes never set attendees, alarms, notes or URLs, and
// deletes only touch an item that still matches what the caller expects (ComputerUseHelper/EventKit.swift saves).

/// The version of the EventKit commands (`eventkit.*`, `calendar.*`, `reminders.*`), reported in `hello` as `eventKit`;
/// a helper without the key predates them and answers `method_not_found`. 2 added the write commands (`calendar.create`,
/// `reminders.create`, `reminders.get`, `reminders.complete`, `calendar.delete`, `reminders.delete`).
public let eventKitProtocol = 2

/// The longest range one `calendar.events` request reads.
public let maxEventRangeDays = 92
/// The most rows one request answers; the reply says when more were left out.
public let maxEventKitRows = 500

/// What an EKAuthorizationStatus raw value means: macOS 14 has notDetermined 0, restricted 1, denied 2, fullAccess 3
/// (the old `authorized`) and writeOnly 4, which can't read and so counts as not granted for MoMo.
public func eventKitAuthorizationName(_ raw: Int) -> String {
    switch raw {
    case 0: return "notDetermined"
    case 1: return "restricted"
    case 2: return "denied"
    case 3: return "granted"
    case 4: return "writeOnly"
    default: return "notDetermined"
    }
}

/// Which EventKit data a request is about.
public enum EventKitEntity: String {
    case calendar
    case reminders

    /// `params.entity` of `eventkit.request`, nil for anything else.
    public static func parse(_ value: Any?) -> EventKitEntity? {
        (value as? String).flatMap { EventKitEntity(rawValue: $0) }
    }

    /// What the reply says when macOS hasn't granted full access (a write-only grant can't read either). A source macOS never
    /// decided (`notDetermined`) has no entry in the Privacy pane to switch, so it is not sent there: MoMo's Connect asks again.
    public func notGranted(_ status: String) -> HelperError {
        let name = self == .calendar ? "Calendars" : "Reminders"
        if status == "notDetermined" {
            return HelperError(1, "not_granted", "\(name) access hasn't been allowed for MoPilot: macOS has not recorded an answer. Connect it again in MoMo's settings")
        }
        return HelperError(1, "not_granted", "\(name) access isn't granted to MoPilot (System Settings › Privacy & Security › \(name))")
    }
}

/// What EventKit said when the request failed, for main's log: its error domain, code and message on one line.
public func eventKitRequestErrorText(domain: String, code: Int, message: String) -> String {
    "\(domain) \(code): \(message)"
}

/// A time in a request: milliseconds since 1970, as main sends them.
public func eventKitDate(_ value: Any?) -> Date? {
    guard let n = value as? NSNumber, n.doubleValue.isFinite else { return nil }
    return Date(timeIntervalSince1970: n.doubleValue / 1000)
}

/// The `[start, end)` of a `calendar.events` request: both required, end after start, at most `maxEventRangeDays`.
public func eventKitRange(_ params: [String: Any]) -> Result<(Date, Date), HelperError> {
    guard let start = eventKitDate(params["start"]), let end = eventKitDate(params["end"]) else {
        return .failure(.invalidParams("start and end must be times in milliseconds"))
    }
    guard end > start else { return .failure(.invalidParams("end must be after start")) }
    guard end.timeIntervalSince(start) <= Double(maxEventRangeDays) * 86400 else {
        return .failure(.invalidParams("the range may be at most \(maxEventRangeDays) days"))
    }
    return .success((start, end))
}

/// `params.limit`, clamped to 1...maxEventKitRows (the most when missing).
public func eventKitLimit(_ params: [String: Any]) -> Int {
    guard let n = params["limit"] as? NSNumber else { return maxEventKitRows }
    return min(max(n.intValue, 1), maxEventKitRows)
}

/// `params.ids`, the calendars or lists to read; nil (all of them) when missing or empty.
public func eventKitIds(_ params: [String: Any]) -> Set<String>? {
    guard let ids = params["ids"] as? [String], !ids.isEmpty else { return nil }
    return Set(ids)
}

/// A `calendar.events` request, parsed before it reaches the store.
public struct EventQuery: Sendable, Equatable {
    public let start: Date
    public let end: Date
    public let ids: Set<String>?
    public let limit: Int
}

/// A `reminders.items` request, parsed before it reaches the store.
public struct ReminderQuery: Sendable, Equatable {
    public let ids: Set<String>?
    public let completedSince: Date?
    public let limit: Int
}

public func eventQuery(_ params: [String: Any]) -> Result<EventQuery, HelperError> {
    eventKitRange(params).map { EventQuery(start: $0.0, end: $0.1, ids: eventKitIds(params), limit: eventKitLimit(params)) }
}

public func reminderQuery(_ params: [String: Any]) -> ReminderQuery {
    ReminderQuery(ids: eventKitIds(params), completedSince: eventKitDate(params["completedSince"]), limit: eventKitLimit(params))
}

/// Reminders in the order the limit keeps them: open before done; open ones by due (soonest first, none last), then
/// title; done ones most recently completed first.
public func sortedReminderRows(_ rows: [[String: Any]]) -> [[String: Any]] {
    func key(_ r: [String: Any]) -> (Int, Double, String) {
        let done = r["done"] as? Bool ?? false
        let title = r["title"] as? String ?? ""
        if done { return (1, -(r["completed"] as? Double ?? 0), title) }
        return (0, r["due"] as? Double ?? .infinity, title)
    }
    return rows.sorted { a, b in
        let (x, y) = (key(a), key(b))
        if x.0 != y.0 { return x.0 < y.0 }
        if x.1 != y.1 { return x.1 < y.1 }
        return x.2 < y.2
    }
}

/// Attendees as main may see them: names only. A participant with no name, or whose name is just an email address,
/// is counted in `others` and nothing about it is sent.
public func attendeeNames(_ names: [String?]) -> (names: [String], others: Int) {
    var out: [String] = []
    var others = 0
    for raw in names {
        let name = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if name.isEmpty || name.contains("@") { others += 1 } else { out.append(name) }
    }
    return (out, others)
}

/// Milliseconds since 1970 for a reply.
public func eventKitMillis(_ date: Date) -> Double { (date.timeIntervalSince1970 * 1000).rounded() }

/// One event as main gets it.
public func eventRow(title: String?, start: Date, end: Date, allDay: Bool, location: String?, calendar: String,
                     attendees: [String?]) -> [String: Any] {
    let people = attendeeNames(attendees)
    var row: [String: Any] = [
        "title": title ?? "", "start": eventKitMillis(start), "end": eventKitMillis(end), "allDay": allDay,
        "calendar": calendar, "attendees": people.names,
    ]
    if let location, !location.isEmpty { row["location"] = location }
    if people.others > 0 { row["otherAttendees"] = people.others }
    return row
}

/// One reminder as main gets it: its id (so a later complete can name it), title, due time (`dueAllDay` when only a date is
/// set), and whether it's done.
public func reminderRow(id: String, title: String?, list: String, due: DateComponents?, done: Bool, completed: Date?) -> [String: Any] {
    var row: [String: Any] = ["id": id, "title": title ?? "", "list": list, "done": done]
    if let due, let date = Calendar.current.date(from: due) {
        row["due"] = eventKitMillis(date)
        row["dueAllDay"] = due.hour == nil
    }
    if let completed { row["completed"] = eventKitMillis(completed) }
    return row
}

/// The first `limit` rows and whether more were left out.
public func capped(_ rows: [[String: Any]], _ limit: Int) -> [String: Any] {
    ["items": Array(rows.prefix(limit)), "truncated": rows.count > limit]
}

// MARK: - Writes (protocol 2)

/// Failures of the write commands; `reason` is what main's writeError maps.
public func eventKitBadArgs(_ m: String) -> HelperError { HelperError(-32602, "bad_args", m) }
/// A calendar or list that exists but can't be written to (a subscription, birthdays, holidays): its own reason, so main can say so.
public func eventKitReadOnly(_ what: String) -> HelperError { HelperError(-32602, "read_only", "that \(what) is read-only") }
public func eventKitNotFound(_ m: String) -> HelperError { HelperError(3, "not_found", m) }
public let eventKitChanged = HelperError(3, "changed", "the item no longer matches what was expected")
public let eventKitGone = HelperError(3, "gone", "the item no longer exists")

private func nonEmptyString(_ value: Any?) -> String? {
    guard let s = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
    return s
}

private func optionalString(_ params: [String: Any], _ key: String) -> Result<String?, HelperError> {
    guard let raw = params[key], !(raw is NSNull) else { return .success(nil) }
    guard let s = nonEmptyString(raw) else { return .failure(eventKitBadArgs("\(key) must be a non-empty string")) }
    return .success(s)
}

private func flag(_ value: Any?) -> Bool? {
    guard let n = value as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }
    return n.boolValue
}

/// `params.id`: the identifier of an existing item.
public func eventKitItemId(_ params: [String: Any]) -> Result<String, HelperError> {
    guard let id = nonEmptyString(params["id"]) else { return .failure(eventKitBadArgs("id must be a non-empty string")) }
    return .success(id)
}

/// A `calendar.create` request, parsed before it reaches the store.
public struct EventCreate: Sendable, Equatable {
    public let title: String
    public let start: Date
    public let end: Date
    public let allDay: Bool
    public let calendarId: String?
    public let location: String?
}

public func eventCreate(_ params: [String: Any]) -> Result<EventCreate, HelperError> {
    guard let title = nonEmptyString(params["title"]) else { return .failure(eventKitBadArgs("title must be a non-empty string")) }
    guard let start = eventKitDate(params["start"]), let end = eventKitDate(params["end"]) else {
        return .failure(eventKitBadArgs("start and end must be times in milliseconds"))
    }
    guard end > start else { return .failure(eventKitBadArgs("end must be after start")) }
    guard let allDay = flag(params["allDay"]) else { return .failure(eventKitBadArgs("allDay must be true or false")) }
    switch (optionalString(params, "calendarId"), optionalString(params, "location")) {
    case (.failure(let e), _), (_, .failure(let e)): return .failure(e)
    case (.success(let calendarId), .success(let location)):
        return .success(EventCreate(title: title, start: start, end: end, allDay: allDay, calendarId: calendarId, location: location))
    }
}

/// The date components of a reminder's due time: date only when `allDay`, else with hour and minute (local time zone).
public func reminderDueComponents(_ date: Date, allDay: Bool) -> DateComponents {
    var parts: Set<Calendar.Component> = [.year, .month, .day]
    if !allDay { parts.formUnion([.hour, .minute]) }
    return Calendar.current.dateComponents(parts, from: date)
}

/// A `reminders.create` request, parsed before it reaches the store.
public struct ReminderCreate: Sendable, Equatable {
    public let title: String
    public let due: DateComponents?
    public let listId: String?
}

public func reminderCreate(_ params: [String: Any]) -> Result<ReminderCreate, HelperError> {
    guard let title = nonEmptyString(params["title"]) else { return .failure(eventKitBadArgs("title must be a non-empty string")) }
    var due: DateComponents?
    if let raw = params["due"], !(raw is NSNull) {
        guard let date = eventKitDate(raw) else { return .failure(eventKitBadArgs("due must be a time in milliseconds")) }
        var allDay = false
        if let rawFlag = params["dueAllDay"], !(rawFlag is NSNull) {
            guard let f = flag(rawFlag) else { return .failure(eventKitBadArgs("dueAllDay must be true or false")) }
            allDay = f
        }
        due = reminderDueComponents(date, allDay: allDay)
    }
    switch optionalString(params, "listId") {
    case .failure(let e): return .failure(e)
    case .success(let listId): return .success(ReminderCreate(title: title, due: due, listId: listId))
    }
}

/// What a complete or delete expects the item to still look like; `start` only for events.
public struct Expect: Sendable, Equatable {
    public let title: String
    public let start: Date?
}

public func eventKitExpect(_ params: [String: Any], needsStart: Bool) -> Result<Expect, HelperError> {
    guard let expect = params["expect"] as? [String: Any], let title = expect["title"] as? String else {
        return .failure(eventKitBadArgs("expect.title must be given"))
    }
    var start: Date?
    if needsStart {
        guard let date = eventKitDate(expect["start"]) else { return .failure(eventKitBadArgs("expect.start must be a time in milliseconds")) }
        start = date
    }
    return .success(Expect(title: title, start: start))
}

/// Whether an item's title (and start, within a second) is still what the caller expected.
public func eventKitMatches(_ expect: Expect, title: String?, start: Date? = nil) -> Bool {
    guard (title ?? "") == expect.title else { return false }
    if let want = expect.start {
        guard let start, abs(start.timeIntervalSince(want)) <= 1 else { return false }
    }
    return true
}

/// A `reminders.complete` request: the id, the new state and what the reminder must still be called.
public struct ReminderComplete: Sendable, Equatable {
    public let id: String
    public let done: Bool
    public let expect: Expect
}

public func reminderComplete(_ params: [String: Any]) -> Result<ReminderComplete, HelperError> {
    switch eventKitItemId(params) {
    case .failure(let e): return .failure(e)
    case .success(let id):
        guard let done = flag(params["done"]) else { return .failure(eventKitBadArgs("done must be true or false")) }
        return eventKitExpect(params, needsStart: false).map { ReminderComplete(id: id, done: done, expect: $0) }
    }
}

/// A delete request (`calendar.delete` needs the start too, `reminders.delete` only the title).
public func eventKitDelete(_ params: [String: Any], needsStart: Bool) -> Result<(id: String, expect: Expect), HelperError> {
    switch eventKitItemId(params) {
    case .failure(let e): return .failure(e)
    case .success(let id): return eventKitExpect(params, needsStart: needsStart).map { (id, $0) }
    }
}

/// The reply of a create: the new item's id and the title of the calendar or list it landed in.
public func eventKitCreated(id: String, container: String, key: String) -> [String: Any] { ["id": id, key: container] }

/// `reminders.get`'s reply.
public func reminderGetRow(id: String, title: String?, list: String, done: Bool) -> [String: Any] {
    ["id": id, "title": title ?? "", "list": list, "done": done]
}
