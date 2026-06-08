// Test-Harness: validiert die Nicht-GUI-Pipeline (Events -> Segmente -> Bericht
// -> Overrides) gegen synthetische Events. Wird NICHT ins App-Bundle gebaut.
import Foundation

func h(_ base: Date, _ hour: Int, _ min: Int) -> Date {
    Calendar.current.date(bySettingHour: hour, minute: min, second: 0, of: base)!
}

let tmp = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("wt-verify-\(UInt32(getpid()))")
try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
let eventsDir = tmp.appendingPathComponent("events")
let dailyDir = tmp.appendingPathComponent("daily")

let store = EventStore(eventsDir: eventsDir)
let dayStore = DayStore(eventStore: store, dailyDir: dailyDir)

// Testtag = gestern, 08:00–16:30, mit zwei Pausen.
let base = Calendar.current.date(byAdding: .day, value: -1, to: Date())!
let endOfDay = h(base, 23, 59)

// Kanonische State-Machine-Events: .active (Arbeit zaehlt) bis .inactive.
store.append(Event(ts: h(base, 8, 0), type: .active, reason: "launch"))
store.append(Event(ts: h(base, 8, 30), type: .sample, app: "Code", repo: "JUMO-Website-CMS", branch: "wcms-2155-b2b", ticket: "WCMS-2155"))
store.append(Event(ts: h(base, 9, 30), type: .sample, app: "Code", repo: "JUMO-Website-CMS", branch: "wcms-2155-b2b", ticket: "WCMS-2155"))
store.append(Event(ts: h(base, 10, 0), type: .inactive, reason: "lock"))  // Pause 1 Beginn
store.append(Event(ts: h(base, 10, 12), type: .active, reason: "unlock"))  // 12 min Pause
store.append(Event(ts: h(base, 11, 30), type: .sample, app: "Chrome", repo: "aem-commerce-prerender", branch: "prerender-x", ticket: nil))
store.append(Event(ts: h(base, 12, 0), type: .inactive, reason: "idle"))   // Pause 2 Beginn (Mittag)
store.append(Event(ts: h(base, 12, 18), type: .active, reason: "input"))   // 18 min Pause
store.append(Event(ts: h(base, 14, 0), type: .sample, app: "Code", repo: "JUMO-Website-CMS", branch: "wcms-2155-b2b", ticket: "WCMS-2155"))
store.append(Event(ts: h(base, 16, 30), type: .inactive, reason: "quit"))

print("=== Auto-Ableitung ===")
let segs = dayStore.deriveSegments(date: base, now: endOfDay)
for s in segs {
    let kind = s.kind == .work ? "ARBEIT" : "pause "
    print("  \(kind) \(Fmt.clock(s.start))-\(Fmt.clock(s.end))  \(Fmt.hm(s.duration))  \(s.ticket ?? "-")")
}
let sum = dayStore.summary(date: base, now: endOfDay)
print("  -> Start \(sum.start.map(Fmt.clock) ?? "-"), Ende \(sum.end.map(Fmt.clock) ?? "-")")
print("  -> Gearbeitet \(Fmt.hm(sum.workedSeconds)), Pause \(Fmt.hm(sum.breakSeconds))")
assert(segs.filter { $0.kind == .work }.count == 3, "erwartet 3 Arbeitsbloecke")
assert(segs.filter { $0.kind == .breakTime }.count == 2, "erwartet 2 Pausen")
// Pause gesamt = 12 + 18 = 30 min
assert(abs(sum.breakSeconds - 30*60) < 1, "Pause sollte 30 min sein, war \(sum.breakSeconds/60)")
print("  ✓ 3 Arbeitsbloecke, 2 Pausen, 30 min Pause korrekt")

print("\n=== Ticket-Zuordnung ===")
let firstWork = segs.first { $0.kind == .work }!
assert(firstWork.ticket == "WCMS-2155", "erstes Ticket WCMS-2155, war \(firstWork.ticket ?? "nil")")
print("  ✓ Branch wcms-2155-b2b -> Ticket \(firstWork.ticket!)")
assert(GitProbe.ticket(fromBranch: "prerendercheck") == nil)
assert(GitProbe.ticket(fromBranch: "WCMS-83-plp") == "WCMS-83")
print("  ✓ Branch-Parsing: 'prerendercheck'->kein Ticket, 'WCMS-83-plp'->WCMS-83")

print("\n=== Manuelles Override (materialisieren) ===")
assert(!dayStore.isMaterialized(base))
var edited = segs
edited.append(Segment(start: h(base, 17, 0), end: h(base, 18, 0), kind: .work,
                      ticket: "WCMS-999", note: "Nachgetragen: Doku", source: .manual))
dayStore.save(date: base, segments: edited)
assert(dayStore.isMaterialized(base), "Tag muss nach Edit materialisiert sein")
let reload = dayStore.segments(date: base, now: endOfDay)
assert(reload.contains { $0.note == "Nachgetragen: Doku" }, "manueller Block muss erhalten bleiben")
let sum2 = dayStore.summary(date: base, now: endOfDay)
print("  ✓ Manueller Block ergaenzt; gearbeitet jetzt \(Fmt.hm(sum2.workedSeconds))")
dayStore.resetToAuto(date: base)
assert(!dayStore.isMaterialized(base), "reset muss Override entfernen")
print("  ✓ 'Auf Auto zuruecksetzen' entfernt Override")

print("\n=== Bericht (Markdown + CSV) ===")
let cfg = AppConfig.makeDefault()
let summaryForReport = dayStore.summary(date: base, now: endOfDay)
ReportWriter.write(date: base, summary: summaryForReport, config: cfg, dailyDir: dailyDir)
let mdURL = dailyDir.appendingPathComponent("\(Fmt.dayKey(base)).md")
let csvURL = dailyDir.appendingPathComponent("\(Fmt.dayKey(base)).csv")
let md = try String(contentsOf: mdURL, encoding: .utf8)
print(md)
print("=== CSV ===")
print(try String(contentsOf: csvURL, encoding: .utf8))
assert(md.contains("WCMS-2155"))
assert(md.contains("Pause"))

try? FileManager.default.removeItem(at: tmp)
print("\nALL CHECKS PASSED ✅")
