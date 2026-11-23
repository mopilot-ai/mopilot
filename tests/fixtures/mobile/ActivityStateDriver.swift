// Drives ActivityState.swift on a Mac: decoding a push with unknown or missing fields, and the row labels with the titles switch off, the key removed, or a key that opens. Prints one JSON object for tests/phoneActivityState.test.ts.
import Foundation

let decoder = JSONDecoder()
func decode(_ json: String) -> ActivityState? { try? decoder.decode(ActivityState.self, from: Data(json.utf8)) }

var out: [String: Any] = [:]

// a push with a field this app does not know, and rows missing
let unknown = decode(#"{"needs":1,"running":2,"kind":"needs","since":1900000000,"diff":"+80 -230","nested":{"a":1},"rows":[{"kind":"running","since":5,"ref":"r1","command":"rm -rf"}]}"#)
out["unknownDecoded"] = unknown != nil
out["unknownRows"] = unknown?.rows.count ?? -1
out["unknownRowSt"] = unknown?.rows.first?.st == nil
let bare = decode(#"{"needs":0,"running":0,"kind":"done","since":0}"#)
out["bareRows"] = bare?.rows.count ?? -1
// a missing required field or a wrong type is not decoded (the system keeps the previous frame)
out["missingNeeds"] = decode(#"{"running":0,"kind":"done","since":0}"#) == nil
out["wrongType"] = decode(#"{"needs":"1","running":0,"kind":"done","since":0}"#) == nil

// labels
let sealedRow = ActivityRow(kind: "needs", since: 10, ref: "chat", st: "SEALED")
var calls = 0
let opens: (String, String) -> String? = { sealed, ref in calls += 1; return sealed == "SEALED" && ref == "chat" ? "Clean up generated files" : nil }
let none: (String, String) -> String? = { _, _ in calls += 1; return nil }
out["labelOff"] = ActivityText.label(sealedRow, titlesAllowed: false, open: opens)
out["callsAfterOff"] = calls
out["labelOpened"] = ActivityText.label(sealedRow, titlesAllowed: true, open: opens)
out["labelKeyRemoved"] = ActivityText.label(sealedRow, titlesAllowed: true, open: none)
out["labelNoBlob"] = ActivityText.label(ActivityRow(kind: "running", since: 1, ref: "c", st: nil), titlesAllowed: true, open: opens)
out["labelKinds"] = ["needs", "running", "done", "other"].map { ActivityText.fixed($0) }

// headline, footer, rows
let both = ActivityState(needs: 1, running: 2, kind: "needs", since: 100)
let many = ActivityState(needs: 3, running: 0, kind: "needs", since: 100)
let done = ActivityState(needs: 0, running: 0, kind: "done", since: 0)
out["headlines"] = [both, many, ActivityState(needs: 0, running: 4, kind: "running", since: 1), done].map { ActivityText.headline($0) }
out["footers"] = [both, ActivityState(needs: 0, running: 4, kind: "running", since: 1), done].map { ActivityText.footer($0) }
out["derivedRows"] = ActivityText.rows(both).map { "\($0.kind):\($0.since)" }
out["derivedDone"] = ActivityText.rows(done).map { $0.kind }
let four = ActivityState(needs: 1, running: 3, kind: "needs", since: 1, rows: (0..<4).map { ActivityRow(kind: "running", since: $0, ref: "r\($0)", st: nil) })
out["rowCap"] = ActivityText.rows(four).count
out["islandCounts"] = [both, many, ActivityState(needs: 0, running: 4, kind: "running", since: 1), done].map { ActivityText.islandCount($0) }
out["finished"] = [both.isFinished, done.isFinished]

// the state survives a round trip through the encoder (what the widget stores)
let round = try? decoder.decode(ActivityState.self, from: try JSONEncoder().encode(four))
out["roundTrip"] = round == four

let data = try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
