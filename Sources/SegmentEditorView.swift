//
//  SegmentEditorView.swift
//  WorkTracker
//
//  Sheet zum Bearbeiten eines vorhandenen oder Anlegen eines neuen Zeitblocks
//  (z. B. wenn etwas nicht automatisch getrackt wurde).
//

import SwiftUI

struct SegmentEditorView: View {
    let date: Date
    let segment: Segment?
    let config: AppConfig
    let onSave: (Segment) -> Void
    let onDelete: (() -> Void)?

    @Environment(\.dismiss) private var dismiss

    @State private var start: Date
    @State private var end: Date
    @State private var kind: SegmentKind
    @State private var ticket: String
    @State private var note: String

    init(date: Date, segment: Segment?, config: AppConfig,
         onSave: @escaping (Segment) -> Void, onDelete: (() -> Void)?) {
        self.date = date
        self.segment = segment
        self.config = config
        self.onSave = onSave
        self.onDelete = onDelete

        let cal = Calendar.current
        let defaultStart = cal.date(bySettingHour: max(0, config.workdayStartHour + 3),
                                    minute: 0, second: 0, of: date) ?? date
        let defaultEnd = cal.date(byAdding: .hour, value: 1, to: defaultStart) ?? date
        _start = State(initialValue: segment?.start ?? defaultStart)
        _end = State(initialValue: segment?.end ?? defaultEnd)
        _kind = State(initialValue: segment?.kind ?? .work)
        _ticket = State(initialValue: segment?.ticket ?? "")
        _note = State(initialValue: segment?.note ?? "")
    }

    private var isNew: Bool { segment == nil }
    private var ticketSuggestions: [String] {
        Array(Set(config.projects.compactMap {
            GitProbe.ticket(fromBranch: GitProbe.currentBranch($0.repoPath))
        })).sorted()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(isNew ? "Neuer Eintrag" : "Eintrag bearbeiten")
                .font(.headline)
                .padding([.top, .horizontal], 20)
                .padding(.bottom, 8)

            Form {
                Picker("Art", selection: $kind) {
                    Text("Arbeit").tag(SegmentKind.work)
                    Text("Pause").tag(SegmentKind.breakTime)
                }
                .pickerStyle(.segmented)

                DatePicker("Von", selection: $start, displayedComponents: .hourAndMinute)
                DatePicker("Bis", selection: $end, displayedComponents: .hourAndMinute)

                if kind == .work {
                    TextField("Ticket oder Titel (z. B. PROJ-123 oder „Meeting“)", text: $ticket)
                    if !ticketSuggestions.isEmpty {
                        HStack {
                            Text("Vorschläge:").foregroundStyle(.secondary).font(.caption)
                            ForEach(ticketSuggestions, id: \.self) { t in
                                Button(t) { ticket = t }
                                    .buttonStyle(.link).font(.caption)
                            }
                        }
                    }
                    TextField("Notiz (was wurde gemacht)", text: $note, axis: .vertical)
                        .lineLimit(1...3)
                }
            }
            .formStyle(.grouped)

            Divider()
            HStack {
                if let onDelete {
                    Button(role: .destructive) {
                        onDelete(); dismiss()
                    } label: { Label("Löschen", systemImage: "trash") }
                }
                Spacer()
                Button("Abbrechen") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(isNew ? "Hinzufügen" : "Sichern") { save() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(end <= start)
            }
            .padding(20)
        }
        .frame(width: 420)
    }

    private func save() {
        var seg = segment ?? Segment(start: start, end: end, kind: kind, source: .manual)
        seg.start = start
        seg.end = end
        seg.kind = kind
        seg.ticket = kind == .work ? (ticket.isEmpty ? nil : ticket) : nil
        seg.note = note.isEmpty ? nil : note
        onSave(seg)
        dismiss()
    }
}
