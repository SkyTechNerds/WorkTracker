//
//  CalendarView.swift
//  WorkTracker
//
//  Kalender-/Timeline-Ansicht: Tagesansicht mit Zeitachse und farbigen
//  Arbeits-/Pausenbloecken sowie Wochenuebersicht. Bloecke sind editierbar,
//  neue Eintraege koennen manuell ergaenzt werden (fuer nicht automatisch
//  getrackte Zeiten). HIG: Standard-Toolbar, SF Symbols, semantische Farben.
//

import SwiftUI
import AppKit

enum CalMode: String, CaseIterable, Identifiable {
    case day = "Tag"
    case week = "Woche"
    var id: String { rawValue }
}

/// Ziel des Editor-Sheets: neuer Eintrag oder Bearbeitung eines Segments.
/// Ueber `.sheet(item:)` praesentiert – so kommt der exakte Wert sicher an.
enum EditorTarget: Identifiable {
    case new
    case edit(Segment)

    var id: String {
        switch self {
        case .new: return "new"
        case .edit(let s): return s.id.uuidString
        }
    }

    var segment: Segment? {
        if case .edit(let s) = self { return s }
        return nil
    }
}

struct CalendarView: View {
    @ObservedObject var tracker: Tracker
    @EnvironmentObject var configStore: ConfigStore

    @State private var mode: CalMode = .day
    @State private var selectedDate: Date = Calendar.current.startOfDay(for: Date())
    @State private var segments: [Segment] = []
    @State private var editorTarget: EditorTarget?
    @State private var deletingBreak: Segment?
    @State private var assigningGroup: TicketGroupRef?
    @State private var aiRunning = false
    @State private var aiMessage: String?

    private var dayStore: DayStore { tracker.dayStore }
    private var cal: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.firstWeekday = 2 // Montag
        return c
    }

    var body: some View {
        VStack(spacing: 0) {
            content
        }
        .toolbar { toolbarItems }
        .navigationTitle(titleText)
        .onAppear(perform: reload)
        .onChange(of: selectedDate) { _, _ in reload() }
        .onReceive(Timer.publish(every: 60, on: .main, in: .common).autoconnect()) { _ in
            // Live halten (Tail wächst), aber nicht während eines offenen Dialogs.
            if editorTarget == nil && deletingBreak == nil && assigningGroup == nil {
                reload()
            }
        }
        .sheet(item: $editorTarget) { target in
            SegmentEditorView(
                date: selectedDate,
                segment: target.segment,
                config: configStore.config,
                onSave: { seg in upsert(seg) },
                onDelete: target.segment.map { s in { requestDelete(s) } })
        }
        .sheet(item: $deletingBreak) { brk in
            DeleteBreakView(
                breakSeg: brk,
                onExtend: { until in extendOverDeletedBreak(brk, until: until) },
                onJustDelete: { delete(brk) })
        }
        .sheet(item: $assigningGroup) { g in
            TicketAssignView(
                group: g.key,
                available: groupSeconds(g.key),
                suggestions: ticketSuggestions,
                currentNote: noteForGroup(g.key),
                onSave: { t, n, dur in assignTicket(group: g.key, ticket: t, note: n, durationSeconds: dur) })
        }
        .alert("KI-Tätigkeiten", isPresented: Binding(
            get: { aiMessage != nil },
            set: { if !$0 { aiMessage = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(aiMessage ?? "")
        }
    }

    // MARK: - Inhalt

    @ViewBuilder
    private var content: some View {
        switch mode {
        case .day:
            summaryBar
            Divider()
            HStack(spacing: 0) {
                DayTimelineView(
                    date: selectedDate,
                    segments: segments,
                    startHour: configStore.config.workdayStartHour,
                    endHour: configStore.config.workdayEndHour,
                    onTap: { seg in editorTarget = .edit(seg) })
                Divider()
                ticketPanel.frame(width: 250)
            }
        case .week:
            VStack(spacing: 0) {
                WeekView(
                    weekStart: weekStart,
                    dayStore: dayStore,
                    cal: cal,
                    onPick: { d in selectedDate = d; mode = .day })
                Divider()
                weekTicketPanel
            }
        }
    }

    // MARK: - Zeit je Ticket (Panels)

    private func ticketRows(_ segs: [Segment]) -> [(ticket: String, seconds: TimeInterval, note: String?)] {
        var time: [String: TimeInterval] = [:]
        var notes: [String: Set<String>] = [:]
        for s in segs where s.kind == .work {
            let k = s.ticket ?? "Ohne Ticket"
            time[k, default: 0] += s.duration
            if let n = s.note, !n.isEmpty { notes[k, default: []].insert(n) }
        }
        return time.sorted { $0.value > $1.value }.map {
            (ticket: $0.key, seconds: $0.value,
             note: notes[$0.key]?.sorted().joined(separator: "; "))
        }
    }

    private var ticketPanel: some View {
        let rows = ticketRows(segments)
        let r = configStore.config.roundingMinutes
        return VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Zeit je Ticket").font(.headline)
                Spacer()
                if configStore.config.aiEnabled {
                    Button {
                        Task { await runAI() }
                    } label: {
                        if aiRunning { ProgressView().controlSize(.small) }
                        else { Image(systemName: "sparkles") }
                    }
                    .buttonStyle(.borderless)
                    .disabled(aiRunning)
                    .help("KI: Tätigkeiten aus den Commits beschreiben")
                }
            }
            .padding(12)
            Divider()
            if rows.isEmpty {
                Spacer()
                Text("keine Arbeitszeit")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                Spacer()
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(rows, id: \.ticket) { row in
                            Button {
                                assigningGroup = TicketGroupRef(key: row.ticket)
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    HStack {
                                        Text(row.ticket).font(.callout).bold()
                                            .foregroundStyle(row.ticket == "Ohne Ticket" ? .orange : .primary)
                                        Spacer()
                                        Text(Fmt.hm(row.seconds, roundTo: r))
                                            .font(.callout).monospacedDigit()
                                            .foregroundStyle(.secondary)
                                        Image(systemName: "pencil")
                                            .font(.caption2).foregroundStyle(.tertiary)
                                    }
                                    if let n = row.note, !n.isEmpty {
                                        Text(n).font(.caption).foregroundStyle(.secondary)
                                            .multilineTextAlignment(.leading)
                                    }
                                }
                                .contentShape(Rectangle())
                                .padding(.vertical, 4)
                            }
                            .buttonStyle(.plain)
                            .help("Ticket zuweisen / bearbeiten")
                        }
                    }
                    .padding(12)
                }
            }
        }
    }

    private var weekTicketPanel: some View {
        let rows = dayStore.weekTicketTotals(weekStart: weekStart, cal: cal)
        let r = configStore.config.roundingMinutes
        return VStack(alignment: .leading, spacing: 8) {
            Text("Zeit je Ticket (Woche)").font(.headline)
            if rows.isEmpty {
                Text("keine Arbeitszeit").foregroundStyle(.secondary)
            } else {
                ForEach(rows, id: \.ticket) { row in
                    HStack {
                        Text(row.ticket)
                        Spacer()
                        Text(Fmt.hm(row.seconds, roundTo: r))
                            .monospacedDigit().foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - KI

    @MainActor
    private func runAI() async {
        aiRunning = true
        defer { aiRunning = false }
        let cfg = configStore.config

        // Arbeitsblöcke des Tages (Index in der aktuellen Segmentliste).
        let blocks = segments.enumerated().filter { $0.element.kind == .work }
        guard !blocks.isEmpty else { aiMessage = "Keine Arbeitsblöcke an diesem Tag."; return }

        // Commits mit Uhrzeit + Ticket (aus Branch ODER Commit-Text).
        let day0 = cal.startOfDay(for: selectedDate)
        let day1 = cal.date(byAdding: .day, value: 1, to: day0)!
        struct CommitLine { let time: Date; let ticket: String?; let subject: String; let project: String }
        var commits: [CommitLine] = []
        for p in cfg.projects {
            let branchTicket = GitProbe.ticket(fromBranch: GitProbe.currentBranch(p.repoPath))
            for c in GitProbe.commitsBetween(repoPath: p.repoPath, since: day0, until: day1, authorEmail: p.gitUserEmail) {
                let t = GitProbe.ticket(fromBranch: c.subject) ?? branchTicket
                commits.append(CommitLine(time: c.date, ticket: t, subject: c.subject, project: p.name))
            }
        }
        guard !commits.isEmpty else {
            aiMessage = "Keine Commits für diesen Tag gefunden — Tätigkeiten bitte manuell ergänzen."
            return
        }
        commits.sort { $0.time < $1.time }

        var blockText = "Arbeitsblöcke:\n"
        for (i, seg) in blocks { blockText += "[\(i)] \(Fmt.clock(seg.start))–\(Fmt.clock(seg.end))\n" }
        var commitText = "Commits (Uhrzeit | Ticket | Projekt | Nachricht):\n"
        for c in commits { commitText += "- \(Fmt.clock(c.time)) | \(c.ticket ?? "-") | \(c.project) | \(c.subject)\n" }

        let system = "Du ordnest Arbeitszeit-Blöcke anhand von Git-Commits (mit Uhrzeiten) zu und beschreibst die Tätigkeit knapp und sachlich auf Deutsch."
        let user = """
        Ordne jedem Arbeitsblock anhand der Commit-Uhrzeiten das wahrscheinlichste \
        Ticket zu (oder einen kurzen Titel, falls kein Ticketnummer-Bezug erkennbar ist), \
        plus eine kurze deutsche Tätigkeitsbeschreibung. Nutze, welche Commits zeitlich \
        in oder nahe am Block liegen. Wenn nichts passt, lass "ticket" leer.
        Antworte NUR als JSON-Array: \
        [{"block": <index>, "ticket": "<Ticket oder Titel oder ''>", "description": "<kurzer Satz>"}].

        \(blockText)
        \(commitText)
        """
        do {
            let text = try await LLMClient.complete(
                baseURL: cfg.aiBaseURL, apiKey: cfg.aiApiKey, model: cfg.aiModel,
                system: system, user: user)
            let arr = LLMClient.parseJSONArray(text)
            guard !arr.isEmpty else { aiMessage = "KI-Antwort konnte nicht gelesen werden."; return }

            var list = segments
            var filled = 0
            for item in arr {
                guard let bi = item["block"] as? Int, list.indices.contains(bi),
                      list[bi].kind == .work else { continue }
                let ticket = (item["ticket"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let desc = (item["description"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                var changed = false
                if !ticket.isEmpty, (list[bi].ticket ?? "").isEmpty { list[bi].ticket = ticket; changed = true }
                if !desc.isEmpty, (list[bi].note ?? "").isEmpty { list[bi].note = desc; changed = true }
                if changed { filled += 1 }
            }
            if filled > 0 { persist(list) }
            aiMessage = filled > 0
                ? "✓ \(filled) Block/Blöcke per KI gefüllt (Ticket/Titel + Beschreibung)."
                : "Keine neuen Zuordnungen gefunden (Blöcke schon ausgefüllt?)."
        } catch {
            aiMessage = "KI-Fehler: \(error.localizedDescription)"
        }
    }

    private var summaryBar: some View {
        // Aus DERSELBEN Segmentliste rechnen wie das Ticket-Panel (sonst driften
        // obere Summe und Panel um die seit dem Laden verstrichene Zeit auseinander).
        let worked = segments.filter { $0.kind == .work }.reduce(0.0) { $0 + $1.duration }
        let brk = segments.filter { $0.kind == .breakTime }.reduce(0.0) { $0 + $1.duration }
        let start = segments.map(\.start).min()
        let end = segments.map(\.end).max()
        let r = configStore.config.roundingMinutes
        return HStack(spacing: 16) {
            Label("\(start.map(Fmt.clock) ?? "–") – \(end.map(Fmt.clock) ?? "–")", systemImage: "clock")
            Label(Fmt.hm(worked, roundTo: r), systemImage: "briefcase")
            Label(Fmt.hm(brk), systemImage: "cup.and.saucer")
                .foregroundStyle(brk > Double(configStore.config.breakCapMinutes) * 60 ? .orange : .secondary)
            if dayStore.isMaterialized(selectedDate) {
                Label("manuell korrigiert", systemImage: "pencil")
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .font(.callout)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbarItems: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            Picker("Ansicht", selection: $mode) {
                ForEach(CalMode.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .fixedSize()
        }
        ToolbarItemGroup {
            Button { shift(-1) } label: { Image(systemName: "chevron.left") }
                .help(mode == .day ? "Vorheriger Tag" : "Vorherige Woche")
            Button("Heute") { selectedDate = cal.startOfDay(for: Date()) }
                .help("Zu heute springen")
            Button { shift(1) } label: { Image(systemName: "chevron.right") }
                .help(mode == .day ? "Nächster Tag" : "Nächste Woche")

            Spacer()

            if cal.isDateInToday(selectedDate) {
                if tracker.dayEnded {
                    Button {
                        tracker.manualResumeWork(); reload()
                    } label: { Label("Arbeit fortsetzen", systemImage: "play.circle") }
                        .help("Feierabend aufheben und weiterarbeiten")
                } else {
                    Button {
                        tracker.manualEndDay(); reload()
                    } label: { Label("Feierabend", systemImage: "moon.fill") }
                        .help("Arbeitszeit für heute beenden – spätere Nutzung zählt nicht mehr")
                }
            }

            if mode == .day {
                Button {
                    editorTarget = .new
                } label: { Label("Eintrag", systemImage: "plus") }
                    .help("Neuen Zeiteintrag hinzufügen")
            }

            // Selteneres im Menü (Textlabels → eindeutig, vermeidet Überlauf).
            Menu {
                Button {
                    tracker.writeReport(for: selectedDate)
                    NSWorkspace.shared.open(reportURL)
                } label: { Label("Tagesbericht öffnen", systemImage: "doc.text") }
                if mode == .day && dayStore.isMaterialized(selectedDate) {
                    Button {
                        dayStore.resetToAuto(date: selectedDate); reload()
                    } label: { Label("Auf Auto zurücksetzen", systemImage: "arrow.uturn.backward") }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .help("Weitere Aktionen (Bericht, Auf Auto)")
        }
    }

    private var reportURL: URL {
        configStore.dailyDirURL.appendingPathComponent("\(Fmt.dayKey(selectedDate)).md")
    }

    // MARK: - Logik

    private var weekStart: Date {
        let comps = cal.dateComponents([.yearForWeekOfYear, .weekOfYear], from: selectedDate)
        return cal.date(from: comps) ?? selectedDate
    }

    private var titleText: String {
        mode == .day ? Fmt.weekdayLong(selectedDate) : "Woche ab \(Fmt.weekdayLong(weekStart))"
    }

    private func shift(_ n: Int) {
        let unit: Calendar.Component = mode == .day ? .day : .weekOfYear
        if let d = cal.date(byAdding: unit, value: n, to: selectedDate) {
            selectedDate = cal.startOfDay(for: d)
        }
    }

    private func reload() {
        segments = dayStore.segments(date: selectedDate)
    }

    /// Fuegt ein bearbeitetes/neues Segment ein und materialisiert den Tag.
    /// Beim Bearbeiten einer Pause ziehen die angrenzenden Arbeitsblöcke mit.
    private func upsert(_ seg: Segment) {
        var list = segments
        if let idx = list.firstIndex(where: { $0.id == seg.id }) {
            list[idx] = seg
            if seg.kind == .breakTime { coupleAroundBreak(&list, seg) }
        } else {
            var s = seg
            s.source = .manual
            list.append(s)
        }
        persist(list)
    }

    /// Passt die zeitlich direkt angrenzenden Arbeitsblöcke an die (neuen)
    /// Pausengrenzen an: davor endet die Arbeit am Pausenbeginn, danach beginnt
    /// sie am Pausenende.
    private func coupleAroundBreak(_ list: inout [Segment], _ brk: Segment) {
        let sorted = list.sorted { $0.start < $1.start }
        guard let pos = sorted.firstIndex(where: { $0.id == brk.id }) else { return }
        if pos > 0 {
            let prev = sorted[pos - 1]
            if prev.kind == .work, let i = list.firstIndex(where: { $0.id == prev.id }),
               brk.start > list[i].start {
                list[i].end = brk.start
            }
        }
        if pos < sorted.count - 1 {
            let next = sorted[pos + 1]
            if next.kind == .work, let j = list.firstIndex(where: { $0.id == next.id }),
               brk.end < list[j].end {
                list[j].start = brk.end
            }
        }
    }

    /// Löschen anstoßen: bei Pausen erst nachfragen (Arbeit verlängern?), sonst
    /// direkt löschen.
    private func requestDelete(_ seg: Segment) {
        if seg.kind == .breakTime {
            // Verzögern, damit der Editor-Sheet zuerst schließt.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                deletingBreak = seg
            }
        } else {
            delete(seg)
        }
    }

    private func delete(_ seg: Segment) {
        persist(segments.filter { $0.id != seg.id })
    }

    /// Pause löschen und die davorliegende Arbeit bis `until` verlängern; reicht
    /// sie an den nächsten Arbeitsblock heran, werden beide verschmolzen.
    private func extendOverDeletedBreak(_ brk: Segment, until: Date) {
        var list = segments
        let sorted = list.sorted { $0.start < $1.start }
        guard let pos = sorted.firstIndex(where: { $0.id == brk.id }) else { delete(brk); return }
        let prev = pos > 0 ? sorted[pos - 1] : nil
        let next = pos < sorted.count - 1 ? sorted[pos + 1] : nil

        list.removeAll { $0.id == brk.id }

        if let prev, prev.kind == .work, let i = list.firstIndex(where: { $0.id == prev.id }) {
            list[i].end = max(list[i].start + 60, until)
            if let next, next.kind == .work, let j = list.firstIndex(where: { $0.id == next.id }),
               list[i].end >= list[j].start {
                list[i].end = max(list[i].end, list[j].end)
                if list[i].ticket == nil { list[i].ticket = list[j].ticket }
                if (list[i].note ?? "").isEmpty { list[i].note = list[j].note }
                list.remove(at: j)
            }
        } else if let next, next.kind == .work, let j = list.firstIndex(where: { $0.id == next.id }) {
            list[j].start = min(list[j].end - 60, brk.start)
        }
        persist(list)
    }

    // MARK: - Ticket-Zuweisung (Panel)

    private var ticketSuggestions: [String] {
        Array(Set(configStore.config.projects.compactMap {
            GitProbe.ticket(fromBranch: GitProbe.currentBranch($0.repoPath))
        })).sorted()
    }

    private func noteForGroup(_ key: String) -> String? {
        segments.first {
            $0.kind == .work && ($0.ticket ?? "Ohne Ticket") == key && !($0.note ?? "").isEmpty
        }?.note
    }

    private func groupSeconds(_ key: String) -> TimeInterval {
        segments.filter { $0.kind == .work && ($0.ticket ?? "Ohne Ticket") == key }
            .reduce(0) { $0 + $1.duration }
    }

    /// Weist Arbeitsblöcken einer Gruppe ein Ticket (+ Notiz) zu. Mit
    /// `durationSeconds` wird nur dieser Anteil (vom frühesten Block an)
    /// zugewiesen und ggf. ein Block geteilt; der Rest bleibt in der Gruppe.
    private func assignTicket(group: String, ticket: String, note: String, durationSeconds: TimeInterval?) {
        let t = ticket.trimmingCharacters(in: .whitespacesAndNewlines)
        let n = note.trimmingCharacters(in: .whitespacesAndNewlines)
        var list = segments
        let targets = list.indices
            .filter { list[$0].kind == .work && (list[$0].ticket ?? "Ohne Ticket") == group }
            .sorted { list[$0].start < list[$1].start }
        let total = targets.reduce(0.0) { $0 + list[$1].duration }

        // Volle Zuweisung (kein bzw. voller Dauerwert).
        guard let dur = durationSeconds, dur > 0, dur < total - 1 else {
            for i in targets {
                list[i].ticket = t.isEmpty ? nil : t
                if !n.isEmpty { list[i].note = n }
            }
            persist(list)
            return
        }

        // Teil-Zuweisung: vom frühesten Block an `dur` Sekunden zuweisen.
        var remaining = dur
        var added: [Segment] = []
        for i in targets {
            if remaining <= 0 { break }
            let seg = list[i]
            if seg.duration <= remaining + 1 {
                list[i].ticket = t.isEmpty ? nil : t
                if !n.isEmpty { list[i].note = n }
                remaining -= seg.duration
            } else {
                let cut = seg.start.addingTimeInterval(remaining)
                var assigned = seg
                assigned.id = UUID()
                assigned.end = cut
                assigned.ticket = t.isEmpty ? nil : t
                assigned.note = n.isEmpty ? seg.note : n
                assigned.source = .manual
                list[i].start = cut          // Restblock bleibt in der Gruppe
                added.append(assigned)
                remaining = 0
            }
        }
        list.append(contentsOf: added)
        persist(list)
    }

    private func persist(_ list: [Segment]) {
        dayStore.save(date: selectedDate, segments: list)
        reload()
        tracker.writeReport(for: selectedDate)
        if cal.isDateInToday(selectedDate) { tracker.refreshSummary() }
    }
}

/// Wrapper, damit eine Ticket-Gruppe als `.sheet(item:)` präsentierbar ist.
struct TicketGroupRef: Identifiable {
    let key: String
    var id: String { key }
}

// MARK: - Tages-Timeline

struct DayTimelineView: View {
    let date: Date
    let segments: [Segment]
    let startHour: Int
    let endHour: Int
    let onTap: (Segment) -> Void

    private let hourHeight: CGFloat = 52
    private let gutter: CGFloat = 56

    var body: some View {
        ScrollView {
            GeometryReader { geo in
                let totalHeight = CGFloat(endHour - startHour) * hourHeight
                let blockWidth = geo.size.width - gutter - 24

                ZStack(alignment: .topLeading) {
                    // Stundenraster
                    ForEach(startHour...endHour, id: \.self) { h in
                        let y = CGFloat(h - startHour) * hourHeight
                        Path { p in
                            p.move(to: CGPoint(x: gutter, y: y))
                            p.addLine(to: CGPoint(x: geo.size.width, y: y))
                        }
                        .stroke(Color.secondary.opacity(0.15), lineWidth: 1)
                        Text(String(format: "%02d:00", h))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .position(x: gutter / 2, y: y)
                    }

                    // Segmente
                    ForEach(segments) { seg in
                        blockView(seg, width: blockWidth)
                            .offset(x: gutter + 8, y: yOffset(seg.start))
                    }
                }
                .frame(height: totalHeight + 8)
            }
            .frame(height: CGFloat(endHour - startHour) * hourHeight + 24)
            .padding(.vertical, 8)
        }
    }

    private func minutes(_ date: Date) -> CGFloat {
        let cal = Calendar.current
        let comps = cal.dateComponents([.hour, .minute], from: date)
        return CGFloat((comps.hour ?? 0) * 60 + (comps.minute ?? 0))
    }

    private func yOffset(_ date: Date) -> CGFloat {
        (minutes(date) - CGFloat(startHour) * 60) / 60 * hourHeight
    }

    @ViewBuilder
    private func blockView(_ seg: Segment, width: CGFloat) -> some View {
        let h = max(16, CGFloat(seg.duration) / 3600 * hourHeight)
        let isWork = seg.kind == .work
        Button {
            onTap(seg)
        } label: {
            RoundedRectangle(cornerRadius: 6)
                .fill(isWork ? Color.accentColor.opacity(0.85) : Color.secondary.opacity(0.25))
                .frame(width: max(40, width), height: h)
                .overlay(alignment: .topLeading) {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 4) {
                            if seg.source == .manual {
                                Image(systemName: "pencil").font(.caption2)
                            }
                            Text(isWork ? (seg.ticket ?? "Arbeit") : "Pause")
                                .font(.caption).bold()
                            Spacer()
                            Text("\(Fmt.clock(seg.start))–\(Fmt.clock(seg.end))")
                                .font(.caption2)
                        }
                        if let n = seg.note, !n.isEmpty {
                            Text(n).font(.caption2).lineLimit(1)
                        }
                    }
                    .foregroundStyle(isWork ? Color.white : Color.primary)
                    .padding(.horizontal, 6).padding(.vertical, 3)
                }
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(seg.source == .manual ? Color.white.opacity(0.9) : Color.clear,
                                style: StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Klicken zum Bearbeiten")
    }
}

// MARK: - Wochenuebersicht

struct WeekView: View {
    let weekStart: Date
    let dayStore: DayStore
    let cal: Calendar
    let onPick: (Date) -> Void

    var body: some View {
        let days = (0..<7).compactMap { cal.date(byAdding: .day, value: $0, to: weekStart) }
        HStack(spacing: 8) {
            ForEach(days, id: \.self) { d in
                let s = dayStore.summary(date: d)
                Button {
                    onPick(d)
                } label: {
                    VStack(spacing: 6) {
                        Text(Fmt.weekdayShort(d)).font(.caption).bold()
                        Divider()
                        Text(Fmt.hm(s.workedSeconds)).font(.title3).monospacedDigit()
                        Text("Pause \(Fmt.hm(s.breakSeconds))")
                            .font(.caption2).foregroundStyle(.secondary)
                        Spacer()
                        if let st = s.start, let en = s.end {
                            Text("\(Fmt.clock(st))–\(Fmt.clock(en))")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(8)
                    .background(RoundedRectangle(cornerRadius: 8).fill(.quaternary.opacity(0.5)))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(16)
    }
}

// MARK: - Pause löschen (mit Verlängern-Option)

struct DeleteBreakView: View {
    let breakSeg: Segment
    let onExtend: (Date) -> Void
    let onJustDelete: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var until: Date

    init(breakSeg: Segment, onExtend: @escaping (Date) -> Void, onJustDelete: @escaping () -> Void) {
        self.breakSeg = breakSeg
        self.onExtend = onExtend
        self.onJustDelete = onJustDelete
        _until = State(initialValue: breakSeg.end)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Pause löschen").font(.headline)
            Text("Soll die Arbeit die gelöschte Pause füllen? Gib an, bis wann gearbeitet wurde — vorausgefüllt mit dem Pausenende (\(Fmt.clock(breakSeg.end))).")
                .font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            DatePicker("Arbeit ging bis", selection: $until, displayedComponents: .hourAndMinute)

            Divider()
            HStack {
                Button("Abbrechen") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Spacer()
                Button("Nur Pause löschen") {
                    let f = onJustDelete; dismiss()
                    DispatchQueue.main.async { f() }
                }
                Button("Arbeit verlängern") {
                    let u = until, f = onExtend; dismiss()
                    DispatchQueue.main.async { f(u) }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 440)
    }
}

// MARK: - Ticket einer Gruppe zuweisen/bearbeiten

struct TicketAssignView: View {
    let group: String
    let available: TimeInterval
    let suggestions: [String]
    let onSave: (String, String, TimeInterval?) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var ticket: String
    @State private var note: String
    @State private var minutes: Int
    private let fullMinutes: Int

    init(group: String, available: TimeInterval, suggestions: [String],
         currentNote: String?, onSave: @escaping (String, String, TimeInterval?) -> Void) {
        self.group = group
        self.available = available
        self.suggestions = suggestions
        self.onSave = onSave
        let full = max(0, Int((available / 60).rounded()))
        self.fullMinutes = full
        _minutes = State(initialValue: full)
        _ticket = State(initialValue: group == "Ohne Ticket" ? "" : group)
        _note = State(initialValue: currentNote ?? "")
    }

    /// Dauer-Aufteilung nur sinnvoll beim Zuordnen von „Ohne Ticket"-Zeit.
    private var allowDuration: Bool { group == "Ohne Ticket" && fullMinutes > 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(group == "Ohne Ticket" ? "Ticket zuweisen" : "Ticket bearbeiten")
                .font(.headline)
            Text("Gilt für \(group == "Ohne Ticket" ? "die nicht zugeordnete Zeit" : "alle Blöcke von \(group)") an diesem Tag.")
                .font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            TextField("Ticket oder Titel (z. B. PROJ-123 oder „Meeting“)", text: $ticket)
                .textFieldStyle(.roundedBorder)
            if !suggestions.isEmpty {
                HStack(spacing: 8) {
                    Text("Vorschläge:").font(.caption).foregroundStyle(.secondary)
                    ForEach(suggestions, id: \.self) { t in
                        Button(t) { ticket = t }.buttonStyle(.link).font(.caption)
                    }
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Beschreibung (mehrzeilig, Markdown möglich)")
                    .font(.caption).foregroundStyle(.secondary)
                TextEditor(text: $note)
                    .frame(minHeight: 80)
                    .font(.body)
                    .scrollContentBackground(.hidden)
                    .padding(6)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
            }

            if allowDuration {
                Divider()
                Stepper(value: $minutes, in: 0...fullMinutes, step: 5) {
                    LabeledContent("Dauer für dieses Ticket",
                                   value: Fmt.hm(Double(minutes * 60)))
                }
                Text("Verfügbar: \(Fmt.hm(Double(fullMinutes * 60))). Weniger wählen → der Rest bleibt „Ohne Ticket“ (z. B. für Arbeit ohne GitHub-Commit wie Figma).")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Divider()
            HStack {
                Spacer()
                Button("Abbrechen") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Sichern") {
                    let dur: TimeInterval? = (allowDuration && minutes < fullMinutes)
                        ? Double(minutes * 60) : nil
                    let t = ticket, n = note, f = onSave
                    dismiss()
                    DispatchQueue.main.async { f(t, n, dur) }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 440)
    }
}
