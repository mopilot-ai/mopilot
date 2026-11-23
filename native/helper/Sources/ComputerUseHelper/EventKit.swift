import EventKit
import Foundation
import HelperCore

/// MoMo's Calendar and Reminders through EventKit: reads, and (protocol 2) creating an item, completing a reminder and
/// deleting an item the caller names. Nothing is read or written until the user grants macOS full access to the helper
/// (`eventkit.request` shows the prompt, only when main asks); every command checks the grant first and answers
/// `not_granted` without it. Parameters and rows are shaped by HelperCore/EventKit.swift.

private func entityType(_ e: EventKitEntity) -> EKEntityType { e == .calendar ? .event : .reminder }

private func authorization(_ e: EventKitEntity) -> String {
    eventKitAuthorizationName(EKEventStore.authorizationStatus(for: entityType(e)).rawValue)
}

/// `{ protocol, calendar, reminders }`: each "granted", "denied", "restricted", "writeOnly" or "notDetermined".
func eventKitStatus() -> [String: Any] {
    ["protocol": eventKitProtocol, "calendar": authorization(.calendar), "reminders": authorization(.reminders)]
}

private func requireAccess(_ e: EventKitEntity) throws {
    let status = authorization(e)
    guard status == "granted" else { throw e.notGranted(status) }
}

/// The one EKEventStore, used by one request at a time: EventKit's store is not safe to share across threads.
private actor EventKitReader {
    let store = EKEventStore()

    /// Shows the macOS prompt for `e` the first time; afterwards macOS just answers. Replies like eventKitStatus, plus
    /// `asked`: true when the prompt was shown by this call (so main knows the user just answered it, and a status
    /// that is still not granted was their choice, not a silent refusal macOS repeated).
    ///
    /// What EventKit itself answered goes back too (#2999): `granted` (its Bool), `requestError` (the error it threw, as "domain code:
    /// message") and `requestMs`. A request that asked and still leaves notDetermined was answered without a prompt: main sees that
    /// by the status, and this is what it logs. Nothing here is swallowed.
    func request(_ e: EventKitEntity) async -> [String: Any] {
        let asked = EKEventStore.authorizationStatus(for: entityType(e)) == .notDetermined
        var said: [String: Any] = [:]
        if asked {
            let started = Date()
            do {
                switch e {
                case .calendar: said["granted"] = try await store.requestFullAccessToEvents()
                case .reminders: said["granted"] = try await store.requestFullAccessToReminders()
                }
            } catch {
                let ns = error as NSError
                said["requestError"] = eventKitRequestErrorText(domain: ns.domain, code: ns.code, message: ns.localizedDescription)
            }
            said["requestMs"] = Int(Date().timeIntervalSince(started) * 1000)
        }
        return eventKitStatus().merging(["asked": asked]) { a, _ in a }.merging(said) { a, _ in a }
    }

    /// The user's calendars or reminder lists: `{ items: [{ id, title, account }] }`.
    func containers(_ e: EventKitEntity) throws -> [String: Any] {
        try requireAccess(e)
        let rows = store.calendars(for: entityType(e)).map { c -> [String: Any] in
            ["id": c.calendarIdentifier, "title": c.title, "account": c.source?.title ?? ""]
        }
        return ["items": rows]
    }

    private func chosen(_ e: EventKitEntity, _ ids: Set<String>?) -> [EKCalendar]? {
        guard let ids else { return nil }
        return store.calendars(for: entityType(e)).filter { ids.contains($0.calendarIdentifier) }
    }

    /// Events overlapping `[start, end)` in the chosen calendars (all when no ids), soonest first.
    func events(_ q: EventQuery) throws -> [String: Any] {
        try requireAccess(.calendar)
        let calendars = chosen(.calendar, q.ids)
        if let calendars, calendars.isEmpty { return capped([], 1) }
        let rows = store.events(matching: store.predicateForEvents(withStart: q.start, end: q.end, calendars: calendars))
            .sorted { $0.startDate < $1.startDate }
            .map { ev in
                eventRow(title: ev.title, start: ev.startDate, end: ev.endDate, allDay: ev.isAllDay, location: ev.location,
                         calendar: ev.calendar?.title ?? "", attendees: (ev.attendees ?? []).map { $0.name })
            }
        return capped(rows, q.limit)
    }

    /// Open reminders in the chosen lists, plus those completed since `completedSince` when it is given; open ones
    /// first, soonest due first, before the limit (sortedReminderRows).
    func reminders(_ q: ReminderQuery) async throws -> [String: Any] {
        try requireAccess(.reminders)
        let lists = chosen(.reminders, q.ids)
        if let lists, lists.isEmpty { return capped([], 1) }
        var found = await fetch(store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: lists))
        if let since = q.completedSince {
            found += await fetch(store.predicateForCompletedReminders(withCompletionDateStarting: since, ending: nil, calendars: lists))
        }
        let rows = found.map { r in
            reminderRow(id: r.calendarItemIdentifier, title: r.title, list: r.calendar?.title ?? "", due: r.dueDateComponents, done: r.isCompleted,
                        completed: r.completionDate)
        }
        return capped(sortedReminderRows(rows), q.limit)
    }

    // MARK: Writes (never attendees, alarms, notes or URLs; each saves and commits at once)

    func createEvent(_ q: EventCreate) throws -> [String: Any] {
        try requireAccess(.calendar)
        let calendar: EKCalendar
        if let id = q.calendarId {
            guard let c = store.calendars(for: .event).first(where: { $0.calendarIdentifier == id }) else {
                throw eventKitBadArgs("unknown calendar")
            }
            guard c.allowsContentModifications else { throw eventKitReadOnly("calendar") }
            calendar = c
        } else {
            guard let c = store.defaultCalendarForNewEvents else { throw eventKitBadArgs("no default calendar") }
            calendar = c
        }
        let ev = EKEvent(eventStore: store)
        ev.title = q.title
        ev.startDate = q.start
        ev.endDate = q.end
        ev.isAllDay = q.allDay
        ev.calendar = calendar
        if let location = q.location { ev.location = location }
        try store.save(ev, span: .thisEvent, commit: true)
        return eventKitCreated(id: ev.eventIdentifier ?? "", container: calendar.title, key: "calendar")
    }

    func createReminder(_ q: ReminderCreate) throws -> [String: Any] {
        try requireAccess(.reminders)
        let list: EKCalendar
        if let id = q.listId {
            guard let c = store.calendars(for: .reminder).first(where: { $0.calendarIdentifier == id }) else {
                throw eventKitBadArgs("unknown list")
            }
            guard c.allowsContentModifications else { throw eventKitReadOnly("list") }
            list = c
        } else {
            guard let c = store.defaultCalendarForNewReminders() else { throw eventKitBadArgs("no default list") }
            list = c
        }
        let r = EKReminder(eventStore: store)
        r.title = q.title
        r.calendar = list
        if let due = q.due { r.dueDateComponents = due }
        try store.save(r, commit: true)
        return eventKitCreated(id: r.calendarItemIdentifier, container: list.title, key: "list")
    }

    private func reminder(_ id: String) -> EKReminder? { store.calendarItem(withIdentifier: id) as? EKReminder }

    func getReminder(_ id: String) throws -> [String: Any] {
        try requireAccess(.reminders)
        guard let r = reminder(id) else { throw eventKitNotFound("no such reminder") }
        return reminderGetRow(id: r.calendarItemIdentifier, title: r.title, list: r.calendar?.title ?? "", done: r.isCompleted)
    }

    func completeReminder(_ q: ReminderComplete) throws -> [String: Any] {
        try requireAccess(.reminders)
        guard let r = reminder(q.id) else { throw eventKitGone }
        guard eventKitMatches(q.expect, title: r.title) else { throw eventKitChanged }
        r.isCompleted = q.done
        r.completionDate = q.done ? Date() : nil
        try store.save(r, commit: true)
        return ["id": q.id]
    }

    func deleteEvent(_ id: String, _ expect: Expect) throws -> [String: Any] {
        try requireAccess(.calendar)
        guard let ev = store.event(withIdentifier: id) else { throw eventKitGone }
        guard eventKitMatches(expect, title: ev.title, start: ev.startDate) else { throw eventKitChanged }
        try store.remove(ev, span: .thisEvent, commit: true)
        return ["id": id]
    }

    func deleteReminder(_ id: String, _ expect: Expect) throws -> [String: Any] {
        try requireAccess(.reminders)
        guard let r = reminder(id) else { throw eventKitGone }
        guard eventKitMatches(expect, title: r.title) else { throw eventKitChanged }
        try store.remove(r, commit: true)
        return ["id": id]
    }

    private func fetch(_ predicate: NSPredicate) async -> [EKReminder] {
        await withCheckedContinuation { c in
            store.fetchReminders(matching: predicate) { c.resume(returning: $0 ?? []) }
        }
    }
}

private let reader = EventKitReader()

/// The methods dispatchEventKit answers (Helper.swift routes them here).
let eventKitMethods: Set<String> = [
    "eventkit.status", "eventkit.request", "calendar.calendars", "calendar.events", "reminders.lists", "reminders.items",
    "calendar.create", "reminders.create", "reminders.get", "reminders.complete", "calendar.delete", "reminders.delete",
]

/// Runs one EventKit command off the socket's queue and replies with its rows or its HelperError.
func dispatchEventKit(_ method: String, _ params: [String: Any], _ reply: @escaping (Result<Any, HelperError>) -> Void) {
    Task.detached {
        do {
            switch method {
            case "eventkit.status": reply(.success(eventKitStatus()))
            case "eventkit.request":
                guard let e = EventKitEntity.parse(params["entity"]) else { throw HelperError.invalidParams("entity must be calendar or reminders") }
                reply(.success(await reader.request(e)))
            case "calendar.calendars": reply(.success(try await reader.containers(.calendar)))
            case "reminders.lists": reply(.success(try await reader.containers(.reminders)))
            case "calendar.events": reply(.success(try await reader.events(try eventQuery(params).get())))
            case "reminders.items": reply(.success(try await reader.reminders(reminderQuery(params))))
            case "calendar.create": reply(.success(try await reader.createEvent(try eventCreate(params).get())))
            case "reminders.create": reply(.success(try await reader.createReminder(try reminderCreate(params).get())))
            case "reminders.get": reply(.success(try await reader.getReminder(try eventKitItemId(params).get())))
            case "reminders.complete": reply(.success(try await reader.completeReminder(try reminderComplete(params).get())))
            case "calendar.delete":
                let d = try eventKitDelete(params, needsStart: true).get()
                reply(.success(try await reader.deleteEvent(d.id, d.expect)))
            case "reminders.delete":
                let d = try eventKitDelete(params, needsStart: false).get()
                reply(.success(try await reader.deleteReminder(d.id, d.expect)))
            default: throw HelperError.methodNotFound(method)
            }
        } catch let e as HelperError {
            reply(.failure(e))
        } catch {
            reply(.failure(HelperError(-32603, "internal", error.localizedDescription)))
        }
    }
}
